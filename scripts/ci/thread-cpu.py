#!/usr/bin/env python3
"""CPU time of the threads of a macOS process whose names match a pattern.

The iOS simulator runs an app as a process of the host. ps shows no names
of its threads, so scripts/ci/device.sh could not measure the React Native
JS thread on iOS. The kernel gives the name and the CPU time of each
thread (proc_pidinfo), to a process of the same user, with no root.

Usage: thread-cpu.py <pid> <regex>
Prints the CPU time (user and system) of the matching threads in ms, the
sum if more than one matches, or "null" when none matches or the process
is gone.
"""
import ctypes
import re
import sys

PROC_PIDTHREADINFO = 5
PROC_PIDLISTTHREADS = 6
MAX_THREADS = 4096


class ThreadInfo(ctypes.Structure):
    # struct proc_threadinfo in <sys/proc_info.h>. The times are in ns.
    _fields_ = [
        ('user_time', ctypes.c_uint64),
        ('system_time', ctypes.c_uint64),
        ('cpu_usage', ctypes.c_int32),
        ('policy', ctypes.c_int32),
        ('run_state', ctypes.c_int32),
        ('flags', ctypes.c_int32),
        ('sleep_time', ctypes.c_int32),
        ('curpri', ctypes.c_int32),
        ('priority', ctypes.c_int32),
        ('maxpriority', ctypes.c_int32),
        ('name', ctypes.c_char * 64),
    ]


def threads(pid):
    """(name, cpu ns) of each thread of the process."""
    libproc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    handles = (ctypes.c_uint64 * MAX_THREADS)()
    size = libproc.proc_pidinfo(pid, PROC_PIDLISTTHREADS, ctypes.c_uint64(0), handles, ctypes.sizeof(handles))
    result = []
    for handle in handles[: max(0, size) // ctypes.sizeof(ctypes.c_uint64)]:
        info = ThreadInfo()
        if libproc.proc_pidinfo(pid, PROC_PIDTHREADINFO, ctypes.c_uint64(handle), ctypes.byref(info), ctypes.sizeof(info)) > 0:
            result.append((info.name.decode('utf-8', 'replace'), info.user_time + info.system_time))
    return result


def main():
    pid, pattern = int(sys.argv[1]), re.compile(sys.argv[2])
    matched = [ns for name, ns in threads(pid) if pattern.search(name)]
    print(int(sum(matched) / 1e6) if matched else 'null')


if __name__ == '__main__':
    main()
