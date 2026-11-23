#import "OodleRum.h"
#import "OodleCrashReporter.h"
#import <zlib.h>

#if __has_include(<OodleMobileSdkReactNative/OodleMobileSdkReactNative-Swift.h>)
#import <OodleMobileSdkReactNative/OodleMobileSdkReactNative-Swift.h>
#else
#import "OodleMobileSdkReactNative-Swift.h"
#endif

// gzip (RFC 1952) of `input`, or nil when zlib fails.
static NSData *_Nullable OodleGzip(NSData *input)
{
  z_stream stream;
  memset(&stream, 0, sizeof(stream));
  // 15 + 16: the largest window, with a gzip header and trailer.
  if (deflateInit2(&stream, Z_DEFAULT_COMPRESSION, Z_DEFLATED, 15 + 16, 8, Z_DEFAULT_STRATEGY) != Z_OK) {
    return nil;
  }
  NSMutableData *output = [NSMutableData dataWithLength:deflateBound(&stream, (uLong)input.length)];
  stream.next_in = (Bytef *)input.bytes;
  stream.avail_in = (uInt)input.length;
  stream.next_out = (Bytef *)output.mutableBytes;
  stream.avail_out = (uInt)output.length;
  int result = deflate(&stream, Z_FINISH);
  uLong written = stream.total_out;
  deflateEnd(&stream);
  if (result != Z_STREAM_END) {
    return nil;
  }
  output.length = written;
  return output;
}

static dispatch_queue_t OodleUploadQueue(void)
{
  static dispatch_queue_t queue;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    queue = dispatch_queue_create("ai.oodle.rum.upload", dispatch_queue_attr_make_with_qos_class(
        DISPATCH_QUEUE_SERIAL, QOS_CLASS_UTILITY, 0));
  });
  return queue;
}

// The transport's REQUEST_TIMEOUT_MS.
static const NSTimeInterval OodleRequestTimeout = 30;

static NSURLSession *OodleUploadSession(void)
{
  static NSURLSession *session;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    NSURLSessionConfiguration *config = [NSURLSessionConfiguration defaultSessionConfiguration];
    config.timeoutIntervalForRequest = OodleRequestTimeout;
    config.URLCache = nil;
    config.HTTPShouldSetCookies = NO;
    session = [NSURLSession sessionWithConfiguration:config];
  });
  return session;
}

// Every method returns a fallback instead of throwing: a failure in
// monitoring code must never reach the app.
@implementation OodleRum

RCT_EXPORT_MODULE()

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (NSString *)getDeviceInfo
{
  @try {
    return [OodleRumImpl.shared deviceInfo];
  } @catch (NSException *e) {
    return @"{}";
  }
}

- (NSString *_Nullable)storageGet:(NSString *)key
{
  @try {
    return [OodleRumImpl.shared storageGet:key];
  } @catch (NSException *e) {
    return nil;
  }
}

- (NSNumber *)storageSet:(NSString *)key value:(NSString *)value
{
  @try {
    return @([OodleRumImpl.shared storageSet:key value:value]);
  } @catch (NSException *e) {
    return @NO;
  }
}

- (void)storageSetAsync:(NSString *)key
                  value:(NSString *)value
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  @try {
    [OodleRumImpl.shared storageSetAsync:key value:value done:^(BOOL ok) {
      resolve(@(ok));
    }];
  } @catch (NSException *e) {
    resolve(@NO);
  }
}

- (NSNumber *)storageRemove:(NSString *)key
{
  @try {
    return @([OodleRumImpl.shared storageRemove:key]);
  } @catch (NSException *e) {
    return @NO;
  }
}

- (NSNumber *)enableCrashReporting
{
  return @([OodleCrashReporter installWithDirectory:[OodleRumImpl.shared storageDirectory]]);
}

- (NSString *_Nullable)consumePendingCrash
{
  @try {
    return [OodleCrashReporter consumeWithDirectory:[OodleRumImpl.shared storageDirectory]];
  } @catch (NSException *e) {
    return nil;
  }
}

- (NSNumber *)startWatchdog:(double)thresholdMs
{
  return @([OodleRumImpl.shared startWatchdog:thresholdMs]);
}

- (NSNumber *)stopWatchdog
{
  return @([OodleRumImpl.shared stopWatchdog]);
}

- (NSNumber *)stopVitals
{
  return @([OodleRumImpl.shared stopVitals]);
}

- (NSString *)drainNativeEvents
{
  return [OodleRumImpl.shared drainNativeEvents];
}

- (NSNumber *)startVitals
{
  return @([OodleRumImpl.shared startVitals]);
}

- (NSString *)collectVitals
{
  return [OodleRumImpl.shared collectVitals];
}

- (NSString *)getConnectivity
{
  return [OodleRumImpl.shared connectivity];
}

- (void)captureWireframes:(NSString *)optionsJson
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async(dispatch_get_main_queue(), ^{
    OodleCaptureTask *task = nil;
    @try {
      task = [OodleRumImpl.shared beginCapture:optionsJson];
    } @catch (NSException *e) {
      reject(@"capture_failed", e.reason ?: e.name, nil);
      return;
    }
    [OodleRum runCaptureSlice:task resolve:resolve reject:reject];
  });
}

// One slice of a walk on the main thread, then the next slice on a later
// turn of the main queue, so the screen can draw between slices. Each
// slice runs in @try: a failure in monitoring code must never reach the app.
+ (void)runCaptureSlice:(OodleCaptureTask *)task
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  @try {
    if (![task step]) {
      dispatch_async(dispatch_get_main_queue(), ^{
        [OodleRum runCaptureSlice:task resolve:resolve reject:reject];
      });
      return;
    }
    [task finish:^(NSString *result) {
      resolve(result);
    }];
  } @catch (NSException *e) {
    [task cancel];
    reject(@"capture_failed", e.reason ?: e.name, nil);
  }
}

// Compresses and posts an upload off the JS thread. In JS, gzip of a
// 500 KB batch and the base64 copy that React Native makes of a binary
// request body both ran on the JS thread before each upload.
- (void)postGzip:(NSString *)url
     headersJson:(NSString *)headersJson
            body:(NSString *)body
         resolve:(RCTPromiseResolveBlock)resolve
          reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async(OodleUploadQueue(), ^{
    @try {
      NSURL *target = [NSURL URLWithString:url];
      if (target == nil) {
        reject(@"bad_url", @"The upload URL is not valid", nil);
        return;
      }
      NSMutableURLRequest *request =
          [NSMutableURLRequest requestWithURL:target
                                  cachePolicy:NSURLRequestReloadIgnoringLocalCacheData
                              timeoutInterval:OodleRequestTimeout];
      request.HTTPMethod = @"POST";
      NSData *headerData = [headersJson dataUsingEncoding:NSUTF8StringEncoding];
      id headers = headerData ? [NSJSONSerialization JSONObjectWithData:headerData options:0 error:nil] : nil;
      if ([headers isKindOfClass:[NSDictionary class]]) {
        [(NSDictionary *)headers enumerateKeysAndObjectsUsingBlock:^(id key, id value, BOOL *stop) {
          if ([key isKindOfClass:[NSString class]] && [value isKindOfClass:[NSString class]]) {
            [request setValue:value forHTTPHeaderField:key];
          }
        }];
      }
      NSData *raw = [body dataUsingEncoding:NSUTF8StringEncoding] ?: [NSData data];
      NSData *compressed = OodleGzip(raw);
      if (compressed != nil) {
        request.HTTPBody = compressed;
        [request setValue:@"gzip" forHTTPHeaderField:@"Content-Encoding"];
      } else {
        request.HTTPBody = raw;
        [request setValue:nil forHTTPHeaderField:@"Content-Encoding"];
      }
      NSURLSessionDataTask *task = [OodleUploadSession()
          dataTaskWithRequest:request
            completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
              if (error != nil || ![response isKindOfClass:[NSHTTPURLResponse class]]) {
                reject(@"network_error", error.localizedDescription ?: @"network error", error);
                return;
              }
              NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
              NSMutableDictionary *result = [NSMutableDictionary dictionary];
              result[@"status"] = @(http.statusCode);
              NSString *limits = [http valueForHTTPHeaderField:@"X-Oodle-Rate-Limits"];
              if (limits != nil) result[@"rateLimits"] = limits;
              NSString *date = [http valueForHTTPHeaderField:@"Date"];
              if (date != nil) result[@"date"] = date;
              NSData *json = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
              resolve(json ? [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding] : @"{\"status\":0}");
            }];
      [task resume];
    } @catch (NSException *e) {
      reject(@"post_failed", e.reason ?: e.name, nil);
    }
  });
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeOodleRumSpecJSI>(params);
}

@end
