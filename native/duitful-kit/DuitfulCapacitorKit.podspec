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
  # 15.5 is the app's own floor (set in patch-ios.mjs). GoogleMLKit used to
  # force it; since 1.64 nothing on iOS pulls ML Kit, but the floor stays put.
  s.ios.deployment_target = '15.5'
  s.dependency 'Capacitor'
  # No GoogleMLKit since 1.64: text recognition is Apple's Vision and dates
  # come from NSDataDetector, both part of iOS. That (with the ML Kit text
  # plugin left out of ios.includePlugins and Tesseract left out of the iOS
  # web bundle) is what took the iPhone app from 86 MB down.
  # Still a static framework, as it was beside ML Kit: it links into the app
  # binary, so the app's own PrivacyInfo.xcprivacy (patch-ios.mjs, 3c) keeps
  # covering its UserDefaults use, and DuitfulRelayWatch links as before.
  s.static_framework = true
  s.frameworks = 'Vision', 'VisionKit', 'PhotosUI', 'BackgroundTasks', 'CryptoKit', 'UserNotifications', 'Security'
  # iOS 26+. Weak, so the app still launches on iOS 15–18.
  s.weak_frameworks = 'FoundationModels'
  s.swift_version = '5.9'
end
