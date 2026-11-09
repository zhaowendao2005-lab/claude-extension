import { expect, test } from 'claude-code/testing'
import { register } from '../hooks/register'

function harness() {
  const hooks: {name:string;filter:any;fn:any}[] = []
  const on: any = (name:string, filter:any, fn?:any) => {
    hooks.push({name,filter:fn ? filter : undefined,fn:fn ?? filter})
    return {catch:()=>{}}
  }
  register(on, {} as any)
  const db = new Map<string,any>(), files = new Map<string,string>()
  let submitted = 0
  const $:any = {
    plugin:{root:'/plugin'}, session:{id:async()=> 'session-a',append:async()=>{},messages:async()=>[]},
    env:{get:async(k:string)=>k==='HOME'?'/home/test':''},
    fs:{read:async(p:string)=>files.get(p) ?? '{}',write:async(p:string,s:string)=>{files.set(p,s)}},
    command:{register:async()=>{}},tool:{register:async()=>{},call:async()=>({success:true})},
    ui:{status:async()=>{}},clock:{every:()=>{}},prompt:{submit:async()=>{submitted++}},
    agent:{list:async()=>[]},
    process:{run:async(args:string[])=>{
      if(args.includes('-c')) return {exitCode:0,stdout:'',stderr:''}
      const value=(k:string)=>args[args.indexOf(k)+1]
      const action=value('--action'),id=value('--id')
      if(action==='list') return {exitCode:0,stdout:JSON.stringify([...db.values()].map(r=>({id:r.id,ownerSessionId:r.ownerSessionId,status:r.status,updatedAt:r.updatedAt,deliverDir:r.deliverDir}))),stderr:''}
      if(action==='load') return {exitCode:0,stdout:JSON.stringify(db.get(id) ?? null),stderr:''}
      if(action==='save') {
        const old=db.get(id),expected=value('--expected'),r=JSON.parse(value('--data'))
        if((expected==='new' && old)||(expected!=='new' && old?.revision!==Number(expected))) return {exitCode:1,stdout:'',stderr:'store: revision conflict'}
        db.set(id,r); return {exitCode:0,stdout:'{"ok":true}',stderr:''}
      }
      throw new Error('unexpected process')
    }},
  }
  const emit=async(name:string,e:any={})=>{
    let result:any
    for(const h of hooks.filter(h=>h.name===name && (!h.filter || Object.entries(h.filter).every(([k,v])=>e[k]===v)))) result=await h.fn($,e,async()=>({}))
    return result
  }
  const budget=async(a:any)=>hooks.find(h=>h.name==='tool.call'&&h.filter)?.fn($,{...a},async()=>({}))
  const run=()=>[...db.values()][0]
  return {$,emit,budget,run,db,files,hooks,submitted:()=>submitted}
}

test('durable run completes, remains queryable; no idle prompt injection',async()=>{
  const h=harness(); await h.emit('session.start',{cwd:'/project'})
  await h.budget({action:'start',duration:'5m',task:'test'})
  expect(h.run().status).toBe('running')
  await h.budget({action:'close',status:'delivered'})
  expect(h.run().status).toBe('completed')
  expect(h.files.has(`${h.run().deliverDir}/manifest.json`)).toBe(true)
  expect(h.submitted()).toBe(0)
})

test('direct close cannot bypass edit verification; waiver bound to current edit',async()=>{
  const h=harness();await h.emit('session.start',{cwd:'/project'})
  await h.budget({action:'start',duration:'5m'})
  await h.emit('tool.call',{tool:'Write',file_path:'/project/a.ts',toolUseId:'write1'})
  const blocked=await h.budget({action:'close',status:'delivered'})
  expect(blocked.isError).toBe(true)
  expect(h.run().status).toBe('running')
  await h.budget({action:'gate',reason:'data only'})
  await h.emit('tool.call',{tool:'Write',file_path:'/project/b.ts',toolUseId:'write2'})
  expect(h.run().check.waiver).toBe(null)
  expect((await h.budget({action:'close'})).isError).toBe(true)
  await h.budget({action:'cancel'})
  expect(h.run().status).toBe('cancelled')
})

test('Ask pauses throughout next(), worker activity does not resume clock, failure releases pause',async()=>{
  const h=harness();await h.emit('session.start',{cwd:'/project'});await h.budget({action:'start',duration:'5m'})
  const hook=h.hooks.find(x=>x.name==='tool.call'&&!x.filter)!
  let checked=false
  try {
    await hook.fn(h.$,{tool:'AskUserQuestion',toolUseId:'ask1'},async()=>{
      expect(h.run().status).toBe('paused')
      expect(h.run().segmentStart).toBe(null)
      await h.emit('tool.call',{tool:'Read',agentId:'external',toolUseId:'worker-read'})
      expect(h.run().status).toBe('paused');checked=true
      throw new Error('cancelled question')
    })
  } catch {}
  expect(checked).toBe(true)
  expect(h.run().status).toBe('running')
  expect(Object.keys(h.run().pauses).length).toBe(0)
})

test('session end interrupts, does not cancel; different owner cannot recover',async()=>{
  const h=harness();await h.emit('session.start',{cwd:'/project'});await h.budget({action:'start',duration:'5m'})
  const id=h.run().id
  await h.emit('session.end',{reason:'background transfer'})
  expect(h.run().status).toBe('interrupted')
  h.$.session.id=async()=> 'session-b'
  await h.emit('session.start',{cwd:'/project'})
  expect((await h.budget({action:'recover',run:id})).isError).toBe(true)
  expect(h.run().ownerSessionId).toBe('session-a')
  expect((await h.budget({action:'start',duration:'5m'})).isError).toBe(true)
})

test('Stop and turn.complete do not stack idle pauses',async()=>{
  const h=harness();await h.emit('session.start',{cwd:'/project'});await h.budget({action:'start',duration:'5m'})
  await h.emit('classic.Stop');await h.emit('turn.complete')
  expect(h.run().pauses.idle).toBe(1)
  await h.emit('turn.start')
  expect(h.run().status).toBe('running')
})

test('two managed workers complete; empty host list does not erase completion',async()=>{
  const h=harness();await h.emit('session.start',{cwd:'/project'});await h.budget({action:'start',duration:'5m'})
  let serial=0
  h.$.agent.spawn=async()=>({agentId:`agent-${++serial}`,model:'sonnet'})
  const dir=h.run().deliverDir
  h.files.set(`${dir}/cards/a.md`,'write a');h.files.set(`${dir}/cards/b.md`,'write b')
  const dispatched=await h.budget({action:'dispatch',workers:[
    {label:'a',model:'sonnet',card_path:`${dir}/cards/a.md`,files:['/project/a.json']},
    {label:'b',model:'sonnet',card_path:`${dir}/cards/b.md`,files:['/project/b.json']},
  ]})
  expect(dispatched.isError).toBe(undefined)
  expect(Object.keys(h.run().attempts).length).toBe(2)
  await h.emit('turn.complete',{agentId:'agent-1',usage:{model:'actual'}})
  await h.emit('classic.SubagentStop',{agent_id:'agent-1'})
  await h.emit('turn.complete',{agentId:'agent-2'})
  const probed=await h.budget({action:'probe'})
  expect(probed.result[0].text).toContain('completed')
  expect(Object.values(h.run().attempts).every((w:any)=>w.status==='completed')).toBe(true)
  await h.budget({action:'close'})
  expect(h.run().status).toBe('completed')
})

test('verification results are scoped to launch revision; shell text cannot impersonate a check',async()=>{
  const h=harness();await h.emit('session.start',{cwd:'/project'});await h.budget({action:'start',duration:'5m'})
  await h.emit('tool.call',{tool:'Write',file_path:'/project/a.ts',toolUseId:'w1'})
  await h.emit('tool.call',{tool:'Bash',command:'tsc --noEmit',toolUseId:'check1'})
  await h.emit('tool.call',{tool:'Write',file_path:'/project/b.ts',toolUseId:'w2'})
  await h.emit('classic.PostToolUse',{tool_name:'Bash',toolUseId:'check1',tool_response:{exitCode:0}})
  expect(h.run().check.passedRevision).toBe(null)
  await h.emit('tool.call',{tool:'Bash',command:'echo tsc',toolUseId:'fake'})
  await h.emit('classic.PostToolUse',{tool_name:'Bash',toolUseId:'fake',tool_response:{exitCode:0}})
  expect((await h.budget({action:'close'})).isError).toBe(true)
  await h.emit('tool.call',{tool:'Bash',command:'tsc --noEmit',toolUseId:'check2'})
  await h.emit('classic.PostToolUse',{tool_name:'Bash',toolUseId:'check2',tool_response:{exitCode:0}})
  await h.budget({action:'close'})
  expect(h.run().status).toBe('completed')
})

test('explicit retry requires confirmed failed attempt and preserves prior attempt',async()=>{
  const h=harness();await h.emit('session.start',{cwd:'/project'});await h.budget({action:'start',duration:'5m'})
  let serial=0;h.$.agent.spawn=async()=>({agentId:`retry-agent-${++serial}`,model:'sonnet'})
  const dir=h.run().deliverDir;h.files.set(`${dir}/cards/a.md`,'task')
  await h.budget({action:'dispatch',workers:[{label:'a',model:'sonnet',card_path:`${dir}/cards/a.md`,files:['/project/a.json']}]})
  expect((await h.budget({action:'retry',worker:'retry-agent-1'})).isError).toBe(true)
  await h.budget({action:'stop',worker:'retry-agent-1'})
  expect((await h.budget({action:'retry',worker:'retry-agent-1'})).isError).toBe(undefined)
  expect(Object.keys(h.run().attempts).length).toBe(2)
  await h.emit('turn.complete',{agentId:'retry-agent-2'})
  await h.budget({action:'close'})
  expect(h.run().status).toBe('completed')
})

test('probe binds unknown intent to an already completed host worker',async()=>{
  const h=harness();await h.emit('session.start',{cwd:'/project'});await h.budget({action:'start',duration:'5m'})
  let name='';h.$.agent.spawn=async(args:any)=>{name=args.name;throw new Error('lost response')}
  const dir=h.run().deliverDir;h.files.set(`${dir}/cards/a.md`,'task')
  await h.budget({action:'dispatch',workers:[{label:'a',model:'sonnet',card_path:`${dir}/cards/a.md`,files:['/project/a.json']}]})
  h.$.agent.list=async()=>[{id:'recovered',name,status:'completed',type:'general-purpose'}]
  await h.budget({action:'probe'})
  const attempt:any=Object.values(h.run().attempts)[0]
  expect(attempt.agentId).toBe('recovered');expect(attempt.status).toBe('completed')
  await h.budget({action:'close'});expect(h.run().status).toBe('completed')
})

test('path aliases cannot bypass reservations; cancelled workers cannot continue writing',async()=>{
  const h=harness();await h.emit('session.start',{cwd:'/project'});await h.budget({action:'start',duration:'5m'})
  let spawned=0;h.$.agent.spawn=async()=>({agentId:`alias-${++spawned}`,model:'sonnet'})
  const dir=h.run().deliverDir;h.files.set(`${dir}/cards/a.md`,'task')
  const result=await h.budget({action:'dispatch',workers:[
    {label:'a',model:'sonnet',card_path:`${dir}/cards/a.md`,files:['/project//a.json']},
    {label:'b',model:'sonnet',card_path:`${dir}/cards/a.md`,files:['/project/a.json']},
  ]})
  expect(result.isError).toBe(true);expect(spawned).toBe(0)
  await h.budget({action:'dispatch',workers:[{label:'a',model:'sonnet',card_path:`${dir}/cards/a.md`,files:['/project/a.json']}]})
  h.$.tool.call=async()=>({isError:true,text:'cannot stop'})
  await h.budget({action:'cancel'})
  const blocked=await h.emit('tool.call',{tool:'Write',agentId:'alias-1',file_path:'/project/a.json'})
  expect(typeof blocked.deny).toBe('string')
  const shell=await h.emit('tool.call',{tool:'Bash',agentId:'alias-1',command:'touch /project/a.json'})
  expect(typeof shell.deny).toBe('string')
})

test('idle between turns does not block the next action; restart does not fake interruption',async()=>{
  const h=harness();await h.emit('session.start',{cwd:'/project'});await h.budget({action:'start',duration:'5m'})
  await h.emit('turn.complete')
  expect(h.run().pauses.idle).toBe(1)
  expect((await h.budget({action:'phase',phase:'implement'})).isError).toBe(undefined)
  expect(h.run().pauses.idle).toBe(undefined)
  let spawned=0;h.$.agent.spawn=async()=>({agentId:`restart-${++spawned}`,model:'sonnet'})
  const dir=h.run().deliverDir;h.files.set(`${dir}/cards/a.md`,'task')
  await h.budget({action:'dispatch',workers:[{label:'a',model:'sonnet',card_path:`${dir}/cards/a.md`,files:['/project/a.json']}]})
  const id=h.run().id
  await h.emit('session.start',{cwd:'/project'})
  expect(h.run().id).toBe(id)
  expect(h.run().status).not.toBe('interrupted')
  const attempt:any=Object.values(h.run().attempts)[0]
  expect(attempt.status).toBe('unknown')
})

test('dispatch preflights the whole batch; unknown spawn outcome blocks completion',async()=>{
  const h=harness();await h.emit('session.start',{cwd:'/project'});await h.budget({action:'start',duration:'5m'})
  let spawned=0;h.$.agent.spawn=async()=>{spawned++;throw new Error('transport timeout')}
  const dir=h.run().deliverDir;h.files.set(`${dir}/cards/a.md`,'task')
  const bad=await h.budget({action:'dispatch',workers:[
    {label:'a',model:'sonnet',card_path:`${dir}/cards/a.md`,files:['/project/shared']},
    {label:'b',model:'sonnet',card_path:`${dir}/cards/a.md`,files:['/project/shared']},
  ]})
  expect(bad.isError).toBe(true);expect(spawned).toBe(0)
  await h.budget({action:'dispatch',workers:[{label:'a',model:'sonnet',card_path:`${dir}/cards/a.md`,files:['/project/shared']}]})
  expect(spawned).toBe(1)
  expect(Object.values(h.run().attempts).some((w:any)=>w.status==='unknown')).toBe(true)
  expect((await h.budget({action:'close'})).isError).toBe(true)
})
