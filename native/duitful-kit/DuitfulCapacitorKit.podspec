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
  # ML Kit ships static frameworks. Under the Podfile's use_frameworks! a
  # dynamic pod would have to link them itself and doesn't (undefined
  # MLKEntity* symbols); as a static framework it links into the app with
  # the rest of ML Kit, exactly like the text-recognition plugin.
  s.static_framework = true
  s.frameworks = 'VisionKit', 'PhotosUI'
  # iOS 26+. Weak, so the app still launches on iOS 15–18.
  s.weak_frameworks = 'FoundationModels'
  s.swift_version = '5.9'
end
