"""Bounded in-memory manifest reader; never extracts filesystem paths."""
import io,json,sys,zipfile
raw=sys.stdin.buffer.read(2097153)
if len(raw)>2097152: raise ValueError('archive_size')
with zipfile.ZipFile(io.BytesIO(raw)) as z:
    items=z.infolist()
    if len(items)!=1: raise ValueError('entry_count')
    i=items[0]
    if i.filename!='qualification-candidate.json' or i.is_dir() or i.flag_bits & 1 or i.file_size>1048576 or i.file_size<2: raise ValueError('entry_invalid')
    if i.compress_type not in (zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED): raise ValueError('compression_invalid')
    # zipfile checks headers, overlap and CRC; bounded declared size plus bounded
    # read excludes compressed bombs. No archive entry is ever executed.
    with z.open(i) as f:
        data=f.read(1048577)
    if len(data)!=i.file_size: raise ValueError('size_mismatch')
    obj=json.loads(data)
    sys.stdout.write(json.dumps(obj,separators=(',',':')))
