#!/usr/bin/env python3
"""Authoritative, transactional Run snapshots. No third-party dependencies."""
import argparse
import json
import math
import os
import sqlite3
import sys


class StoreError(Exception):
    pass


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise StoreError("invalid command arguments")


def decode(data):
    def reject_constant(_):
        raise StoreError("invalid JSON number")
    try:
        return json.loads(data, parse_constant=reject_constant)
    except (ValueError, TypeError):
        raise StoreError("invalid run JSON") from None


def validate(run, run_id):
    if not isinstance(run, dict) or not run_id or run.get("id") != run_id:
        raise StoreError("run id mismatch")
    if type(run.get("schemaVersion")) is not int or run["schemaVersion"] != 1:
        raise StoreError("unsupported schemaVersion")
    if type(run.get("revision")) is not int or not 0 <= run["revision"] <= 9007199254740991:
        raise StoreError("invalid revision")
    for key in ("ownerSessionId", "status", "deliverDir"):
        if not isinstance(run.get(key), str):
            raise StoreError("invalid run summary")
    updated = run.get("updatedAt")
    if type(updated) not in (int, float) or not math.isfinite(updated):
        raise StoreError("invalid updatedAt")


def execute(args):
    if args.action in ("load", "save") and not args.id:
        raise StoreError("id is required")
    run = None
    expected = None
    if args.action == "save":
        if args.data is None or args.expected is None:
            raise StoreError("save requires data and expected revision")
        run = decode(args.data)
        validate(run, args.id)
        if args.expected != "new":
            try:
                expected = int(args.expected)
            except ValueError:
                raise StoreError("invalid expected revision") from None
            if expected < 0 or expected > 9007199254740991:
                raise StoreError("invalid expected revision")
            if run["revision"] != expected + 1:
                raise StoreError("revision must advance by one")
    os.makedirs(os.path.dirname(os.path.abspath(args.db)), exist_ok=True)
    connection = sqlite3.connect(args.db, timeout=5, isolation_level=None)
    try:
        connection.execute("PRAGMA busy_timeout = 5000")
        connection.execute("PRAGMA synchronous = FULL")
        connection.execute("""CREATE TABLE IF NOT EXISTS runs (
            id TEXT PRIMARY KEY NOT NULL,
            revision INTEGER NOT NULL,
            owner_session_id TEXT NOT NULL,
            status TEXT NOT NULL,
            updated_at REAL NOT NULL,
            deliver_dir TEXT NOT NULL,
            snapshot TEXT NOT NULL
        )""")
        if args.action == "load":
            row = connection.execute("SELECT snapshot FROM runs WHERE id = ?", (args.id,)).fetchone()
            return decode(row[0]) if row else None
        if args.action == "list":
            rows = connection.execute("""SELECT id, owner_session_id, status, updated_at, deliver_dir
                FROM runs ORDER BY updated_at DESC, id""").fetchall()
            return [dict(zip(("id", "ownerSessionId", "status", "updatedAt", "deliverDir"), row)) for row in rows]
        # The comparison and the entire snapshot (including events) share one
        # durable transaction. SQLite's rollback journal recovers interrupted writes.
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute("SELECT revision FROM runs WHERE id = ?", (args.id,)).fetchone()
        if expected is None:
            if row is not None:
                raise StoreError("revision conflict: run already exists")
            # Serialize project admission with the insert, not a bridge-side
            # list check: different IDs must not bypass single-active-run safety.
            active = connection.execute("""SELECT 1 FROM runs
                WHERE status NOT IN ('completed', 'cancelled') LIMIT 1""").fetchone()
            if active is not None:
                raise StoreError("active run already exists for this project")
            # Terminal status does not prove that host-managed writers stopped.
            # Keep admission blocked until their late completion/stop is saved.
            for (snapshot,) in connection.execute("SELECT snapshot FROM runs"):
                previous = decode(snapshot)
                attempts = previous.get("attempts", {})
                if not isinstance(attempts, dict):
                    raise StoreError("invalid stored attempts")
                if any(isinstance(attempt, dict) and attempt.get("managed") is True
                       and attempt.get("status") not in ("completed", "failed")
                       for attempt in attempts.values()):
                    raise StoreError("unresolved managed attempts")
        elif row is None or row[0] != expected:
            raise StoreError("revision conflict")
        values = (run["revision"], run["ownerSessionId"], run["status"],
                  run["updatedAt"], run["deliverDir"],
                  json.dumps(run, ensure_ascii=True, allow_nan=False, separators=(",", ":")), args.id)
        if expected is None:
            connection.execute("""INSERT INTO runs
                (revision, owner_session_id, status, updated_at, deliver_dir, snapshot, id)
                VALUES (?, ?, ?, ?, ?, ?, ?)""", values)
        else:
            connection.execute("""UPDATE runs SET revision = ?, owner_session_id = ?,
                status = ?, updated_at = ?, deliver_dir = ?, snapshot = ? WHERE id = ?""", values)
        connection.execute("COMMIT")
        return None
    finally:
        if connection.in_transaction:
            connection.rollback()
        connection.close()


def main():
    try:
        parser = Parser(description=__doc__)
        parser.add_argument("--db", required=True)
        parser.add_argument("--action", required=True, choices=("load", "save", "list"))
        parser.add_argument("--id")
        parser.add_argument("--expected")
        parser.add_argument("--data")
        result = execute(parser.parse_args())
        print(json.dumps(result, ensure_ascii=True, allow_nan=False, separators=(",", ":")))
        return 0
    except StoreError as error:
        print("store: " + str(error), file=sys.stderr)
    except sqlite3.Error:
        print("store: database operation failed", file=sys.stderr)
    except OSError:
        print("store: filesystem operation failed", file=sys.stderr)
    except (ValueError, TypeError, OverflowError, RecursionError):
        print("store: invalid run data", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
