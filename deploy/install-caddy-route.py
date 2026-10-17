"""Run on the target host. Add only Wenquan's path; validate before reloading Caddy."""
from pathlib import Path
import shutil,subprocess,datetime,hashlib
path=Path('/etc/caddy/Caddyfile')
original=path.read_text()
marker='cx.kevinxu.cn {'
if '/wenquan/' in original:
    raise SystemExit('Wenquan route already exists; inspect rather than overwrite.')
if original.count(marker)!=1:
    raise SystemExit('Target site block must be unique.')
route='\n    handle_path /wenquan/* {\n        reverse_proxy 127.0.0.1:8788\n    }\n'
backup=Path('/opt/wenquan/Caddyfile.before-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
shutil.copy2(path,backup)
path.write_text(original.replace(marker,marker+route,1))
try:
    subprocess.run(['caddy','validate','--config',str(path)],check=True,capture_output=True)
    subprocess.run(['systemctl','reload','caddy'],check=True,capture_output=True)
except subprocess.CalledProcessError:
    shutil.copy2(backup,path)
    raise SystemExit('Caddy validation/reload failed; original configuration restored.')
print('Added Wenquan-only route; Caddy validated and reloaded. Backup:',backup)
print('Previous config SHA256:',hashlib.sha256(original.encode()).hexdigest())
