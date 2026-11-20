#import <Foundation/Foundation.h>

// The codegen spec is C++. Swift builds the module of this pod as
// Objective-C, so the spec is imported only in Objective-C++ files.
#ifdef __cplusplus
#import <OodleRumSpec/OodleRumSpec.h>
#endif

NS_ASSUME_NONNULL_BEGIN

#ifdef __cplusplus
@interface OodleRum : NSObject <NativeOodleRumSpec>
#else
@interface OodleRum : NSObject
#endif
@end

NS_ASSUME_NONNULL_END
