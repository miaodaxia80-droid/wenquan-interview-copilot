#!/usr/bin/env python3
"""补充只读核对 Studio ZIP 的实际组件与 review 哈希，不替代官方检查或签名审核。"""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('bundle', type=Path)
parser.add_argument('--web', type=Path, required=True)
parser.add_argument('--glass', type=Path, required=True)
args = parser.parse_args()
sha = lambda data: hashlib.sha256(data).hexdigest()
with zipfile.ZipFile(args.bundle) as archive:
    names = archive.namelist()
    assert len(names) == len(set(names)) == 4, 'ZIP 必须是四个互不重复的根目录文件'
    web = [n for n in names if n.endswith('.mmpkg')]
    glass = [n for n in names if n.endswith('.gmp')]
    assert len(web) == len(glass) == 1
    assert set(names) == {web[0], glass[0], 'review.json', 'source.enc'}
    review = json.loads(archive.read('review.json'))
    assert review['format'] == 'gm-review'
    assert review['version'] in [1, 2, 3]
    assert archive.read(web[0]) == args.web.read_bytes(), 'MMPKG 字节不一致'
    assert archive.read(glass[0]) == args.glass.read_bytes(), 'GMP 字节不一致'
    assert review['gmp']['sha256'] == sha(archive.read(glass[0])), 'GMP 哈希不一致'
    assert review['source']['sha256'] == sha(archive.read('source.enc')), 'source 哈希不一致'
    report = {
        'bundle': str(args.bundle), 'reviewVersion': review['version'],
        'componentBytesMatch': True, 'reviewHashesMatch': True,
        'bundleSha256': sha(args.bundle.read_bytes()),
        'limitations': '仅字节与哈希核对；不验证签名、审核批准、来源重建、安装或真机运行。'
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
