#import "OodleCrashReporter.h"

#import <execinfo.h>
#import <fcntl.h>
#import <mach/mach.h>
#import <pthread.h>
#import <signal.h>
#import <stdlib.h>
#import <string.h>
#import <sys/ucontext.h>
#import <time.h>
#import <unistd.h>
#if __has_feature(ptrauth_calls)
#import <ptrauth.h>
#endif

static NSString *const kExceptionFile = @"crash-exception.json";
static NSString *const kSignalFile = @"crash-signal.txt";
/// Written by the JS fatal error handler just before it rethrows.
static NSString *const kJsCrashMarker = @"js_crash_marker";
/// A JS fatal reaches native code shortly after the JS handler ran.
static const NSTimeInterval kJsCrashWindowSeconds = 10;

static const int kSignals[] = {SIGABRT, SIGBUS, SIGFPE, SIGILL, SIGSEGV, SIGTRAP, SIGSYS};
static const int kSignalCount = sizeof(kSignals) / sizeof(kSignals[0]);

// The signal handler may only use async-signal-safe calls, so the file
// path is prepared before any signal arrives.
static char gSignalPath[1024];
static struct sigaction gPrevious[NSIG];
static volatile sig_atomic_t gHandled = 0;
/// Set when a signal was passed to the handler installed before ours.
static volatile sig_atomic_t gChained[NSIG];
static NSUncaughtExceptionHandler *gPreviousExceptionHandler = NULL;
static NSString *gDirectory = nil;
static BOOL gInstalled = NO;

static void WriteAll(int fd, const char *s)
{
  size_t len = strlen(s);
  while (len > 0) {
    ssize_t n = write(fd, s, len);
    if (n <= 0) return;
    s += n;
    len -= (size_t)n;
  }
}

static void WriteNumber(int fd, long value)
{
  char buf[24];
  int i = (int)sizeof(buf) - 1;
  buf[i] = '\0';
  BOOL negative = value < 0;
  unsigned long v = negative ? (unsigned long)(-value) : (unsigned long)value;
  do {
    buf[--i] = (char)('0' + (v % 10));
    v /= 10;
  } while (v > 0 && i > 1);
  if (negative) buf[--i] = '-';
  WriteAll(fd, &buf[i]);
}

/// A stack overflow fills the stack of its thread, and a handler that runs
/// there cannot start: the crash was lost. The handler runs on this stack
/// instead (SA_ONSTACK). Each thread needs its own; the main thread and the
/// thread that installs the handler get one. A thread that already has one
/// (Datadog's KSCrash sets one) keeps it. The size leaves room for the
/// handler of a crash reporter that runs after this one.
static const size_t kSignalStackSize = 256 * 1024;

static void InstallSignalStack(void)
{
  stack_t current;
  if (sigaltstack(NULL, &current) != 0) return;
  if (!(current.ss_flags & SS_DISABLE) && current.ss_sp != NULL) return;
  void *memory = calloc(1, kSignalStackSize);
  if (memory == NULL) return;
  stack_t stack;
  stack.ss_sp = memory;
  stack.ss_size = kSignalStackSize;
  stack.ss_flags = 0;
  if (sigaltstack(&stack, NULL) != 0) free(memory);
}

static uintptr_t StripPointer(uintptr_t address)
{
#if __has_feature(ptrauth_calls)
  return (uintptr_t)ptrauth_strip((void *)address, ptrauth_key_return_address);
#else
  return address;
#endif
}

/// The stack of the interrupted code, from the signal context: its program
/// counter, then the return address of each frame on the frame pointer
/// chain. backtrace() walks from the handler instead, and on the signal
/// stack its frames are outside the thread stack, so it found none. The
/// walk reads only the live stack, from the interrupted stack pointer up
/// to the top of the thread stack, with each frame above the last.
static int StackFromContext(void *context, void **frames, int max)
{
  if (context == NULL || max <= 0) return 0;
  _STRUCT_MCONTEXT *mc = ((ucontext_t *)context)->uc_mcontext;
  if (mc == NULL) return 0;
#if defined(__arm64__)
  uintptr_t pc = StripPointer((uintptr_t)arm_thread_state64_get_pc(mc->__ss));
  uintptr_t fp = (uintptr_t)arm_thread_state64_get_fp(mc->__ss);
  uintptr_t sp = (uintptr_t)arm_thread_state64_get_sp(mc->__ss);
  // A leaf function keeps its return address in the link register and
  // saves no frame, so its caller is not on the frame pointer chain.
  uintptr_t lr = StripPointer((uintptr_t)arm_thread_state64_get_lr(mc->__ss));
#elif defined(__x86_64__)
  uintptr_t pc = (uintptr_t)mc->__ss.__rip;
  uintptr_t fp = (uintptr_t)mc->__ss.__rbp;
  uintptr_t sp = (uintptr_t)mc->__ss.__rsp;
  uintptr_t lr = 0;
#else
  return 0;
#endif
  uintptr_t top = (uintptr_t)pthread_get_stackaddr_np(pthread_self());
  int count = 0;
  frames[count++] = (void *)pc;
  bool fpValid = fp >= sp && fp + 2 * sizeof(uintptr_t) <= top && (fp % sizeof(uintptr_t)) == 0;
  uintptr_t firstReturn = fpValid ? StripPointer(((uintptr_t *)fp)[1]) : 0;
  if (lr != 0 && lr != pc && lr != firstReturn && count < max) frames[count++] = (void *)lr;
  while (count < max && fp >= sp && fp + 2 * sizeof(uintptr_t) <= top && (fp % sizeof(uintptr_t)) == 0) {
    uintptr_t *record = (uintptr_t *)fp;
    uintptr_t next = record[0];
    uintptr_t ret = StripPointer(record[1]);
    if (ret == 0) break;
    frames[count++] = (void *)ret;
    if (next <= fp) break;
    fp = next;
  }
  return count;
}

static void OodleSignalHandler(int sig, siginfo_t *info, void *context)
{
  // An uncaught NSException ends in abort(); its report is already written.
  if (!gHandled) {
    gHandled = 1;
    int fd = open(gSignalPath, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd >= 0) {
      WriteAll(fd, "signal ");
      WriteNumber(fd, sig);
      WriteAll(fd, "\ntime ");
      WriteNumber(fd, (long)time(NULL));
      WriteAll(fd, "\n");
      void *frames[66];
      int skip = 0;
      int count = StackFromContext(context, frames, 64);
      if (count <= 1) {
        count = backtrace(frames, 66);
        // The first two frames are this handler and _sigtramp, which every
        // signal crash shares. The issue of a crash is named from its top
        // frame, so the stack starts at the code the signal interrupted.
        skip = count > 2 ? 2 : 0;
      }
      backtrace_symbols_fd(frames + skip, count - skip, fd);
      close(fd);
    }
  }
  // Hand the signal to whoever had it before (Datadog's reporter), then
  // let it end the process. A handler that returns can have dealt with
  // the signal, so this handler returns too. If the same signal comes
  // again, the previous handler did not end the process: a fault runs
  // its instruction again after a return, and without the default action
  // the app would loop here instead of ending.
  struct sigaction *previous = &gPrevious[sig];
  if (!gChained[sig]) {
    gChained[sig] = 1;
    if (previous->sa_flags & SA_SIGINFO) {
      if (previous->sa_sigaction) {
        previous->sa_sigaction(sig, info, context);
        return;
      }
    } else if (previous->sa_handler != SIG_DFL && previous->sa_handler != SIG_IGN) {
      previous->sa_handler(sig);
      return;
    }
  }
  struct sigaction dfl;
  memset(&dfl, 0, sizeof(dfl));
  dfl.sa_handler = SIG_DFL;
  sigemptyset(&dfl.sa_mask);
  sigaction(sig, &dfl, NULL);
  raise(sig);
}

static BOOL ReportedByJs(NSException *exception)
{
  // React Native turns a fatal JS error into an RCTFatalException. The JS
  // handler has already recorded it with its JS stack.
  if (![exception.name hasPrefix:@"RCTFatalException"]) return NO;
  NSString *path = [gDirectory stringByAppendingPathComponent:kJsCrashMarker];
  NSString *raw = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:nil];
  if (raw.length == 0) return NO;
  NSTimeInterval at = raw.doubleValue / 1000.0;
  return [[NSDate date] timeIntervalSince1970] - at < kJsCrashWindowSeconds;
}

static void OodleExceptionHandler(NSException *exception)
{
  gHandled = 1;
  @try {
    if (!ReportedByJs(exception)) {
      NSDictionary *crash = @{
        @"timestamp" : @((long long)([[NSDate date] timeIntervalSince1970] * 1000)),
        @"type" : exception.name ?: @"NSException",
        @"message" : exception.reason ?: exception.name ?: @"",
        @"stack" : [exception.callStackSymbols componentsJoinedByString:@"\n"] ?: @"",
        @"source" : @"ios",
      };
      NSData *data = [NSJSONSerialization dataWithJSONObject:crash options:0 error:nil];
      [data writeToFile:[gDirectory stringByAppendingPathComponent:kExceptionFile] atomically:YES];
    }
  } @catch (__unused NSException *ignored) {
  }
  if (gPreviousExceptionHandler) gPreviousExceptionHandler(exception);
}

static NSString *SignalName(int sig)
{
  switch (sig) {
    case SIGABRT: return @"SIGABRT";
    case SIGBUS: return @"SIGBUS";
    case SIGFPE: return @"SIGFPE";
    case SIGILL: return @"SIGILL";
    case SIGSEGV: return @"SIGSEGV";
    case SIGTRAP: return @"SIGTRAP";
    case SIGSYS: return @"SIGSYS";
    default: return [NSString stringWithFormat:@"SIG%d", sig];
  }
}

@implementation OodleCrashReporter

+ (BOOL)installWithDirectory:(NSString *)directory
{
  @synchronized(self) {
    if (gInstalled) return YES;
    gDirectory = [directory copy];
    NSString *signalPath = [directory stringByAppendingPathComponent:kSignalFile];
    strlcpy(gSignalPath, signalPath.fileSystemRepresentation, sizeof(gSignalPath));

    gPreviousExceptionHandler = NSGetUncaughtExceptionHandler();
    NSSetUncaughtExceptionHandler(&OodleExceptionHandler);

    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_sigaction = OodleSignalHandler;
    action.sa_flags = SA_SIGINFO | SA_ONSTACK;
    sigemptyset(&action.sa_mask);
    for (int i = 0; i < kSignalCount; i++) {
      sigaction(kSignals[i], &action, &gPrevious[kSignals[i]]);
    }
    InstallSignalStack();
    if (![NSThread isMainThread]) {
      dispatch_async(dispatch_get_main_queue(), ^{
        InstallSignalStack();
      });
    }
    gInstalled = YES;
    return YES;
  }
}

+ (nullable NSString *)consumeWithDirectory:(NSString *)directory
{
  NSFileManager *fm = [NSFileManager defaultManager];
  NSString *exceptionPath = [directory stringByAppendingPathComponent:kExceptionFile];
  NSString *signalPath = [directory stringByAppendingPathComponent:kSignalFile];
  NSString *result = nil;

  NSString *exception = [NSString stringWithContentsOfFile:exceptionPath encoding:NSUTF8StringEncoding error:nil];
  if (exception.length > 0) {
    result = exception;
  } else {
    NSString *raw = [NSString stringWithContentsOfFile:signalPath encoding:NSUTF8StringEncoding error:nil];
    if (raw.length > 0) {
      int sig = 0;
      double when = [[NSDate date] timeIntervalSince1970];
      NSMutableArray<NSString *> *frames = [NSMutableArray array];
      for (NSString *line in [raw componentsSeparatedByString:@"\n"]) {
        if ([line hasPrefix:@"signal "]) {
          sig = [[line substringFromIndex:7] intValue];
        } else if ([line hasPrefix:@"time "]) {
          when = [[line substringFromIndex:5] doubleValue];
        } else if (line.length > 0) {
          [frames addObject:line];
        }
      }
      NSString *name = SignalName(sig);
      NSDictionary *crash = @{
        @"timestamp" : @((long long)(when * 1000)),
        @"type" : name,
        @"message" : [NSString stringWithFormat:@"Application crashed with %@", name],
        @"stack" : [frames componentsJoinedByString:@"\n"],
        @"source" : @"ios",
      };
      NSData *data = [NSJSONSerialization dataWithJSONObject:crash options:0 error:nil];
      result = data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : nil;
    }
  }
  [fm removeItemAtPath:exceptionPath error:nil];
  [fm removeItemAtPath:signalPath error:nil];
  return result;
}

@end
