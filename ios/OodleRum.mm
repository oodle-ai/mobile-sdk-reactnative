#import "OodleRum.h"
#import "OodleCrashReporter.h"

#if __has_include(<OodleMobileSdkReactNative/OodleMobileSdkReactNative-Swift.h>)
#import <OodleMobileSdkReactNative/OodleMobileSdkReactNative-Swift.h>
#else
#import "OodleMobileSdkReactNative-Swift.h"
#endif

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
    @try {
      resolve([OodleRumImpl.shared captureWireframes:optionsJson]);
    } @catch (NSException *e) {
      reject(@"capture_failed", e.reason ?: e.name, nil);
    }
  });
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeOodleRumSpecJSI>(params);
}

@end
