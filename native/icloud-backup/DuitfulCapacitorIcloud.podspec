require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

# Pod name is what Capacitor's CLI derives from the npm name
# ("duitful-capacitor-icloud" → DuitfulCapacitorIcloud). Rename one, rename both.
Pod::Spec.new do |s|
  s.name = 'DuitfulCapacitorIcloud'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license']
  s.homepage = 'https://duitful.app'
  s.author = package['author']
  s.source = { :git => 'https://github.com/AydilJoe/survey.git', :tag => "v#{package['version']}" }
  s.source_files = 'ios/Sources/**/*.swift'
  s.ios.deployment_target = '14.0'
  s.dependency 'Capacitor'
  s.swift_version = '5.1'
end
