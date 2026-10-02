#!/usr/bin/env python3
"""Record real Pi native operation order; no screen/ANSI/acceptance captures."""
import hashlib,json,os,pathlib,shlex,subprocess,sys,tempfile,time
repo=pathlib.Path(sys.argv[1]).resolve()
server='awe9-order-'+str(os.getpid())
pi=subprocess.check_output(['which','pi'],text=True).strip()
assert subprocess.check_output([pi,'--version'],text=True).strip()=='0.99.1'

def tmux(*args): return subprocess.check_output(['tmux','-L',server,*args],text=True)
def records(root):
 p=root/'native-order.jsonl'
 if not p.exists(): return []
 out=[]
 for line in p.read_text().splitlines():
  try: out.append(json.loads(line))
  except json.JSONDecodeError: pass
 return out

def wait(root,predicate,timeout=25):
 end=time.monotonic()+timeout
 while time.monotonic()<end:
  rows=records(root)
  if predicate(rows): return rows
  time.sleep(.05)
 raise RuntimeError('Native recorder wait timed out: '+str(root))

def launch(seed=False,manifest=None):
 root=pathlib.Path(tempfile.mkdtemp(prefix='visor-order-',dir='/tmp')).resolve()
 (root/'agent').mkdir()
 (root/'agent/settings.json').write_text(json.dumps({'quietStartup':True,'defaultTools':['fixture_hold'],'compaction':{'enabled':False,'reserveTokens':1024,'keepRecentTokens':1}}))
 command=['env','PI_CODING_AGENT_DIR='+str(root/'agent'),'VISOR_TRACE_ROOT='+str(root),'PI_TELEMETRY=0']
 if seed: command+=['VISOR_ORDER_SEED=1','VISOR_NATURAL_MANIFEST='+str(manifest)]
 command+=[pi,'--offline','--tui-mode','fullscreen','--no-extensions','--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--no-approve','--provider','order-fixture','--model','offline','--thinking','off','--session-dir',str(root/'sessions'),'-e',str(repo/'packages/visor/tests/fixtures/record-pi-order.js'),'--tools','fixture_hold']
 (root/'launch.txt').write_text('cd '+shlex.quote(str(root))+'\n'+shlex.join(command)+'\n')
 tmux('new-session','-d','-s','record','-x','120','-y','40','-c',str(root),'exec '+shlex.join(command))
 wait(root,lambda rows:any(r.get('op')=='session_ready' for r in rows))
 time.sleep(.5)
 print('ROOT='+str(root),flush=True)
 return root

def submit(text): tmux('send-keys','-t','record:0.0','-l',text); tmux('send-keys','-t','record:0.0','Enter')
def settled(rows,scene): return any(r.get('op')=='event' and r.get('phase')=='after' and r.get('scene')==scene and r.get('event',{}).get('type')=='agent_settled' for r in rows)
inputs=[]
try:
 natural=launch()
 submit('queue-case'); inputs.append('queue-case + Enter')
 wait(natural,lambda rows:any(r.get('op')=='event' and r.get('event',{}).get('type')=='tool_execution_start' for r in rows))
 tmux('send-keys','-t','record:0.0','C-o'); inputs.append('Ctrl+O during first live fixture tool')
 time.sleep(.15); tmux('send-keys','-t','record:0.0','C-o'); inputs.append('Ctrl+O again for native showStatus duplicate path')
 wait(natural,lambda rows:settled(rows,'queue'))
 submit('no-tool-case'); inputs.append('no-tool-case + Enter')
 wait(natural,lambda rows:settled(rows,'no-tool'))
 for scene in ['abort-text','provider-error','abort-toolstream']:
  submit(scene+'-case'); inputs.append(scene+'-case + Enter')
  wait(natural,lambda rows:any(r.get('op')=='provider_pause' and r.get('scene')==scene for r in rows))
  if scene!='provider-error': tmux('send-keys','-t','record:0.0','Escape'); inputs.append('Escape during '+scene)
  wait(natural,lambda rows:settled(rows,scene))
 tmux('send-keys','-t','record:0.0','C-o'); inputs.append('Ctrl+O before rebuild to prove reset')
 submit('/compact'); inputs.append('/compact + Enter (real compaction, offline summary override)')
 wait(natural,lambda rows:any(r.get('op')=='event' and r.get('phase')=='after' and r.get('event',{}).get('type')=='compaction_end' for r in rows))
 rows=records(natural)
 counts={scene:sum(r.get('op')=='removeChild' and r.get('scene')==scene for r in rows) for scene in ['abort-text','provider-error','abort-toolstream']}
 for scene in counts: assert settled(rows,scene),scene
 assert any(r.get('op')=='splice' for r in rows),'custom entry native splice missing'
 assert sum(r.get('op')=='method' and r.get('phase')=='before' and r.get('method')=='showStatus' for r in rows)>=2
 assert any(r.get('op')=='clear' and r.get('scene')=='compaction' for r in rows),'real compaction clear missing'
 assert any(r.get('op')=='method' and r.get('method')=='renderSessionItems' and r.get('scene')=='compaction' for r in rows)
 submit('/quit')
 deadline=time.monotonic()+10
 while subprocess.run(['tmux','-L',server,'has-session','-t','record'],capture_output=True).returncode==0:
  if time.monotonic()>deadline: raise RuntimeError('Native Pi did not exit before trace finalization')
  time.sleep(.05)
 rows=records(natural)
 counts={scene:sum(r.get('op')=='removeChild' and r.get('scene')==scene for r in rows) for scene in counts}
 manifest={'probedAllThree':True,'removeChildCounts':counts,'tracePath':str(natural/'native-order.jsonl'),'traceSha256':hashlib.sha256((natural/'native-order.jsonl').read_bytes()).hexdigest()}
 (natural/'natural-paths.json').write_text(json.dumps(manifest,indent=2)); (natural/'inputs.json').write_text(json.dumps(inputs,indent=2))
 seeded=None
 if not any(counts.values()):
  seeded=launch(True,natural/'natural-paths.json')
  submit('seed-cleanup-case')
  wait(seeded,lambda rows:settled(rows,'seed-cleanup'))
  seedrows=records(seeded)
  assert any(r.get('op')=='fixture_setup' for r in seedrows)
  assert any(r.get('op')=='removeChild' and r.get('source')=='native' for r in seedrows),'native cleanup guard did not remove seeded empty component'
  submit('/quit'); time.sleep(.5)
 result={'naturalRoot':str(natural),'seededRoot':str(seeded) if seeded else None,'naturalCleanup':counts,'naturalNativeOperations':len(rows),'seedNativeOperations':len(records(seeded)) if seeded else 0,'noTerminalCaptures':True}
 pathlib.Path('/tmp/awe9-record-result.json').write_text(json.dumps(result,indent=2)); print(json.dumps(result,indent=2))
finally:
 subprocess.run(['tmux','-L',server,'kill-server'],capture_output=True)
