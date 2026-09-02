SecMyNet Flutter mobile template

This folder contains a minimal Flutter app that registers for FCM and can register the device push token with the SecMyNet server.

Steps to build locally (Option A - recommended):
1. Install Flutter SDK on your machine: https://docs.flutter.dev/get-started/install
2. Copy your Firebase Android google-services.json into android/app/.
3. Run: flutter pub get
4. Run: flutter build apk --release
5. The APK will appear at build/app/outputs/flutter-apk/app-release.apk

Option B: Use GitHub Actions provided in .github/workflows/flutter-ci.yml
- Add google-services.json to the repo securely (or configure CI to inject it via secrets).
- Push to main; CI will build an APK and upload as an artifact.

Config in the app:
- Modify lib/main.dart SERVER_URL constant to point to your SecMyNet server (use https in production).
- The app uses default sample admin credentials for quick testing; replace with your auth flow.

FCM setup:
- Provide Firebase service account JSON to the server to enable sending messages from server-side.
- Provide google-services.json to the Flutter app to enable receiving pushes on Android.
