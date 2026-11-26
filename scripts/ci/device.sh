# Controls the fixture app on the running Android emulator or the booted
# iOS simulator, for scripts/ci/scenarios.sh and scripts/compare/.
# Source it after PLATFORM is set to android or ios:
#   PLATFORM=android; . scripts/ci/device.sh
# Every measure here comes from outside the app, so it is the same for
# each SDK. On iOS, SIMULATOR chooses the simulator (default: the booted
# one), for a machine that has more than one booted.

if [ "$PLATFORM" = android ]; then
  PKG=com.oodleexample
  app_pid() { adb shell pidof "$PKG" 2> /dev/null | tr -d '\r' || true; }
  # Ends the app if it runs, and starts it. Sets START_MS to the start
  # time that the system measured.
  start_app() {
    adb shell am force-stop "$PKG"
    START_MS=$(adb shell am start -W -n "$PKG/.MainActivity" | tr -d '\r' | awk -F': ' '/^TotalTime/ { print $2 }')
  }
  kill_app() { adb shell am force-stop "$PKG"; }
  background_app() { adb shell input keyevent KEYCODE_HOME; }
  foreground_app() { adb shell am start -n "$PKG/.MainActivity" > /dev/null; }
  # Ends the app and removes what it saved, the outboxes of both SDKs too.
  clear_app_data() { adb shell pm clear "$PKG" > /dev/null; }
  # CPU time of the app process so far, in ms (user and system time).
  cpu_ms() {
    local pid="$1" tck
    tck=$(adb shell getconf CLK_TCK 2> /dev/null | tr -d '\r')
    adb shell cat "/proc/$pid/stat" 2> /dev/null | tr -d '\r' |
      awk -v t="${tck:-100}" '{ sub(/^.*\) /, ""); print int(($12 + $13) * 1000 / t) }'
  }
  # CPU time of the main thread and the React Native JS thread so far, in
  # ms, as JSON: { main, js }. The work that users feel as jank is on
  # these two threads; cpu_ms counts every thread. A value is null when the
  # thread is not found.
  thread_cpu_json() {
    local pid="$1" tck
    tck=$(adb shell getconf CLK_TCK 2> /dev/null | tr -d '\r')
    adb shell "cat /proc/$pid/task/*/stat" 2> /dev/null | tr -d '\r' |
      awk -v t="${tck:-100}" -v pid="$pid" '
        {
          name = $0; sub(/^[^(]*\(/, "", name); sub(/\).*$/, "", name)
          rest = $0; sub(/^.*\) /, "", rest); split(rest, f, " ")
          ms = (f[12] + f[13]) * 1000 / t
          if ($1 == pid) { main = ms; m = 1 }
          # mqt_js before the new architecture, mqt_v_js with it.
          else if (name ~ /^mqt_(v_)?js$/) { js += ms; j = 1 }
        }
        END { printf "{\"main\":%s,\"js\":%s}", m ? int(main) : "null", j ? int(js) : "null" }'
  }
  # Memory of the app process, in KB (PSS). The package names the process.
  mem_kb() {
    adb shell dumpsys meminfo "$PKG" 2> /dev/null | tr -d '\r' |
      awk '/TOTAL PSS:/ { print $3; exit } /^ *TOTAL / { print $2; exit }'
  }
  frames_reset() { adb shell dumpsys gfxinfo "$PKG" reset > /dev/null 2>&1 || true; }
  # Frames since frames_reset, as JSON: { total, janky, p90_ms }.
  frames_json() {
    adb shell dumpsys gfxinfo "$PKG" 2> /dev/null | tr -d '\r' | awk '
      /Total frames rendered:/ && !t { t = $4 }
      /Janky frames:/ && !j { j = $3 }
      /90th percentile:/ && !p { p = $3; sub(/ms/, "", p) }
      END { printf "{\"total\":%d,\"janky\":%d,\"p90_ms\":%d}", t, j, p }'
  }
else
  BUNDLE=org.reactjs.native.example.OodleExample
  SIM="${SIMULATOR:-booted}"
  app_pid() {
    xcrun simctl spawn "$SIM" launchctl list |
      awk -v b="$BUNDLE" 'index($3, b) && $1 != "-" { print $1 }' | head -1
  }
  # The simulator gives no start time that compares with Android's.
  start_app() {
    xcrun simctl launch --terminate-running-process "$SIM" "$BUNDLE" > /dev/null
    START_MS=
  }
  kill_app() { xcrun simctl terminate "$SIM" "$BUNDLE" 2> /dev/null || true; }
  # Another app in front sends the fixture to the background.
  background_app() { xcrun simctl launch "$SIM" com.apple.Preferences > /dev/null; }
  foreground_app() { xcrun simctl launch "$SIM" "$BUNDLE" > /dev/null; }
  # Both SDKs keep their files in the app's Library folder.
  clear_app_data() {
    local data
    kill_app
    data=$(xcrun simctl get_app_container "$SIM" "$BUNDLE" data)
    rm -rf "${data:?}"/Library/* "${data:?}"/Documents/* "${data:?}"/tmp/*
    xcrun simctl spawn "$SIM" defaults delete "$BUNDLE" > /dev/null 2>&1 || true
  }
  # Simulator apps are processes of the host, so the host measures them.
  # ps shows CPU time as [hh:]mm:ss.cc.
  cpu_ms() {
    ps -o time= -p "$1" 2> /dev/null | awk '{
      n = split($1, a, /:/); s = 0
      for (i = 1; i <= n; i++) s = s * 60 + a[i]
      print int(s * 1000) }'
  }
  # ps -M lists the main thread first. The JS thread has no name that ps
  # shows, so it is not measured.
  thread_cpu_json() {
    ps -M -p "$1" 2> /dev/null | awk 'NR == 2 {
      ms = 0
      for (c = 7; c <= 8; c++) { n = split($c, a, /:/); s = 0; for (i = 1; i <= n; i++) s = s * 60 + a[i]; ms += s * 1000 }
      main = int(ms) }
      END { printf "{\"main\":%s,\"js\":null}", (NR >= 2 ? main : "null") }'
  }
  # mem_kb [pid]: the resident memory of the process, in KB. The pid of
  # the launch, so a process that started again is not measured.
  mem_kb() { ps -o rss= -p "${1:-$(app_pid)}" 2> /dev/null | tr -d ' '; }
  # The simulator renders on the host GPU: its frames are not measured.
  frames_reset() { :; }
  frames_json() { printf 'null'; }
fi
