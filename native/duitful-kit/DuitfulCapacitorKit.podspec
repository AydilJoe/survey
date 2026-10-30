require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

# Pod name is what Capacitor's CLI derives from the npm name
# ("duitful-capacitor-kit" → DuitfulCapacitorKit). Rename one, rename both.
# The Android half of this plugin lives in android/ beside this file and is
# installed by scripts/install-duitful-kit.mjs, not by Capacitor.
Pod::Spec.new do |s|
  s.name = 'DuitfulCapacitorKit'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license']
  s.homepage = 'https://duitful.app'
  s.author = package['author']
  s.source = { :git => 'https://github.com/AydilJoe/survey.git', :tag => "v#{package['version']}" }
  s.source_files = 'ios/Sources/**/*.swift'
  # 15.5 is the app's own floor (GoogleMLKit sets it; see patch-ios.mjs).
  s.ios.deployment_target = '15.5'
  s.dependency 'Capacitor'
  # Same GoogleMLKit range as the text-recognition plugin, so CocoaPods
  # resolves both subspecs from one GoogleMLKit release.
  s.dependency 'GoogleMLKit/EntityExtraction', '>= 8.0.0', '< 10.0.0'
  # MLKitEntityExtraction ships no x86_64 simulator slice, so an Intel
  # simulator link fails with undefined MLKEntity* symbols. Simulator builds
  # (the build-only lane) are arm64-only; device builds are untouched. The
  # app target needs the same exclusion or its x86_64 slice can't link us.
  s.pod_target_xcconfig = { 'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'x86_64' }
  s.user_target_xcconfig = { 'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'x86_64' }
  s.frameworks = 'VisionKit', 'PhotosUI'
  # iOS 26+. Weak, so the app still launches on iOS 15–18.
  s.weak_frameworks = 'FoundationModels'
  s.swift_version = '5.9'
end
