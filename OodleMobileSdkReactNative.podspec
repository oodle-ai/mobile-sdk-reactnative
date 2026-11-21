require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "OodleMobileSdkReactNative"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]
  s.platforms    = { :ios => "15.1" }
  s.source       = { :git => package["repository"]["url"], :tag => "v#{s.version}" }
  s.source_files = "ios/**/*.{h,m,mm,swift}"
  s.swift_version = "5.9"
  s.frameworks   = "UIKit", "Network", "QuartzCore"
  # gzip for uploads (OodleRum.mm).
  s.libraries    = "z"
  # The ObjC++ module imports the generated Swift header.
  s.pod_target_xcconfig = { "DEFINES_MODULE" => "YES" }
  # The module glue imports C++ headers, so it stays out of the module
  # that Swift imports.
  s.private_header_files = "ios/OodleRum.h"

  install_modules_dependencies(s)
end
