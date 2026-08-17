"""Parse an Adobe DCP camera profile (TIFF-IFD container, DNG-spec tags).

The profiles themselves are Adobe's copyrighted data and MUST NOT be
committed to this (public) repo - extract them locally from the free Adobe
DNG Converter (mount the dmg read-only, `pkgutil --expand-full` the pkg,
copy CameraRawProfiles.pkg/Payload/CameraProfiles/Camera/<body>/*.dcp) and
keep them under the gitignored profiles/ path. This parser and everything
downstream of it are ours; the tables are not.

Usage: python read_dcp.py "profiles/Nikon Z 6 3 Camera Standard.dcp" [--json out.json]
"""
import struct, sys, json

TAGS = {
    0xC621: "ColorMatrix1", 0xC622: "ColorMatrix2",
    0xC65A: "CalibrationIlluminant1", 0xC65B: "CalibrationIlluminant2",
    0xC6F8: "ProfileName", 0xC6F9: "ProfileHueSatMapDims",
    0xC6FA: "ProfileHueSatMapData1", 0xC6FB: "ProfileHueSatMapData2",
    0xC6FC: "ProfileToneCurve", 0xC6FD: "ProfileEmbedPolicy",
    0xC6FE: "ProfileCopyright",
    0xC714: "ForwardMatrix1", 0xC715: "ForwardMatrix2",
    0xC725: "ProfileLookTableDims", 0xC726: "ProfileLookTableData",
    0xC7A3: "ProfileHueSatMapEncoding", 0xC7A4: "ProfileLookTableEncoding",
    0xC7A5: "BaselineExposureOffset", 0xC7A6: "DefaultBlackRender",
    0xC6F4: "ProfileCalibrationSignature",
}
SIZES = {1:1, 2:1, 3:2, 4:4, 5:8, 6:1, 7:1, 8:2, 9:4, 10:8, 11:4, 12:8}

def parse(path):
    d = open(path, "rb").read()
    bo = "<" if d[:2] == b"II" else ">"
    (ifd_off,) = struct.unpack(bo + "I", d[4:8])
    (n,) = struct.unpack(bo + "H", d[ifd_off:ifd_off+2])
    out = {}
    for i in range(n):
        e = ifd_off + 2 + 12*i
        tag, typ, cnt = struct.unpack(bo + "HHI", d[e:e+8])
        size = SIZES.get(typ, 1) * cnt
        off = e + 8 if size <= 4 else struct.unpack(bo + "I", d[e+8:e+12])[0]
        raw = d[off:off+size]
        if typ == 2:
            val = raw.split(b"\0")[0].decode("utf8", "replace")
        elif typ == 3:
            val = list(struct.unpack(bo + f"{cnt}H", raw))
        elif typ == 4:
            val = list(struct.unpack(bo + f"{cnt}I", raw))
        elif typ in (5, 10):
            fmt = "II" if typ == 5 else "ii"
            parts = struct.unpack(bo + fmt*cnt, raw)
            val = [parts[2*j]/parts[2*j+1] if parts[2*j+1] else 0.0 for j in range(cnt)]
        elif typ == 11:
            val = list(struct.unpack(bo + f"{cnt}f", raw))
        else:
            val = raw.hex()[:64]
        name = TAGS.get(tag, hex(tag))
        out[name] = val
    return out

if __name__ == "__main__":
    p = parse(sys.argv[1])
    for k, v in p.items():
        if isinstance(v, list) and len(v) > 12:
            print(f"{k}: [{len(v)} values] {v[:6]}...")
        else:
            print(f"{k}: {v}")
    if "--json" in sys.argv:
        json.dump(p, open(sys.argv[sys.argv.index("--json")+1], "w"))
