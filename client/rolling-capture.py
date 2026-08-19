#!/usr/bin/env python3
"""Pass signed 16-bit audio through stdout while retaining a bounded raw ring."""

import argparse
import os
import sys


def write_all(fd, data):
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        view = view[written:]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("directory")
    parser.add_argument("prefix")
    parser.add_argument("--rate", type=int, default=22050)
    parser.add_argument("--seconds", type=int, default=60)
    parser.add_argument("--segments", type=int, default=30)
    args = parser.parse_args()

    os.makedirs(args.directory, exist_ok=True)
    segment_bytes = args.rate * 2 * args.seconds
    slot = 0
    size = 0
    capture = None

    try:
        while True:
            chunk = os.read(0, 4096)
            if not chunk:
                break
            write_all(1, chunk)
            offset = 0
            while offset < len(chunk):
                if capture is None:
                    path = os.path.join(args.directory, "%s-%02d.raw" % (args.prefix, slot))
                    capture = open(path, "wb", buffering=0)
                    size = 0
                amount = min(len(chunk) - offset, segment_bytes - size)
                capture.write(chunk[offset:offset + amount])
                offset += amount
                size += amount
                if size >= segment_bytes:
                    capture.close()
                    capture = None
                    slot = (slot + 1) % args.segments
    finally:
        if capture is not None:
            capture.close()


if __name__ == "__main__":
    main()
