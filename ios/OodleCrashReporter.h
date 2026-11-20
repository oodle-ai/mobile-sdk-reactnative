#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Writes an uncaught exception or a fatal signal to disk before the
/// process ends. The JS side sends it on the next start.
@interface OodleCrashReporter : NSObject

+ (BOOL)installWithDirectory:(NSString *)directory;

/// The crash that ended the previous run, as JSON, or nil. Deletes it.
+ (nullable NSString *)consumeWithDirectory:(NSString *)directory;

@end

NS_ASSUME_NONNULL_END
