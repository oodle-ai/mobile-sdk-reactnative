#import "OodleCrashReporter.h"

#import <execinfo.h>
#import <fcntl.h>
#import <signal.h>
#import <string.h>
#import <time.h>
#import <unistd.h>

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
      void *frames[64];
      int count = backtrace(frames, 64);
      backtrace_symbols_fd(frames, count, fd);
      close(fd);
    }
  }
  // Hand the signal to whoever had it before, then let it end the process.
  struct sigaction *previous = &gPrevious[sig];
  if (previous->sa_flags & SA_SIGINFO) {
    if (previous->sa_sigaction) {
      previous->sa_sigaction(sig, info, context);
      return;
    }
  } else if (previous->sa_handler != SIG_DFL && previous->sa_handler != SIG_IGN) {
    previous->sa_handler(sig);
    return;
  }
  sigaction(sig, previous, NULL);
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
