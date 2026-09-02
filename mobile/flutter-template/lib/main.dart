import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

// NOTE: Replace SERVER_URL with your SecMyNet server (use https in production)
const SERVER_URL = 'http://192.168.1.144:3000';

Future<void> _firebaseMessagingBackgroundHandler(RemoteMessage message) async {
  // Called when a message is received in background
  await Firebase.initializeApp();
  print('Background message received: ${message.messageId}');
}

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp();
  FirebaseMessaging.onBackgroundMessage(_firebaseMessagingBackgroundHandler);
  runApp(MyApp());
}

class MyApp extends StatefulWidget {
  @override
  State<MyApp> createState() => _MyAppState();
}

class _MyAppState extends State<MyApp> {
  String _status = 'idle';
  String _token = '';
  String? _jwt;

  @override
  void initState() {
    super.initState();
    _initMessaging();
    _loadToken();
  }

  Future<void> _loadToken() async {
    final prefs = await SharedPreferences.getInstance();
    setState(() {
      _jwt = prefs.getString('jwt');
    });
  }

  Future<void> _initMessaging() async {
    FirebaseMessaging messaging = FirebaseMessaging.instance;
    NotificationSettings settings = await messaging.requestPermission();
    print('User granted permission: ${settings.authorizationStatus}');

    final token = await messaging.getToken();
    print('FCM token: $token');
    setState(() { _token = token ?? ''; });

    FirebaseMessaging.onMessage.listen((RemoteMessage message) {
      print('Foreground message: ${message.data}');
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Push: ${message.notification?.title ?? message.data['title'] ?? ''}')));
    });
  }

  Future<void> _login(String email, String password) async {
    setState(() { _status = 'logging in'; });
    final resp = await http.post(Uri.parse('$SERVER_URL/api/login'), headers: { 'Content-Type': 'application/json' }, body: jsonEncode({ 'email': email, 'password': password }));
    if (resp.statusCode == 200) {
      final body = jsonDecode(resp.body);
      final token = body['token'];
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('jwt', token);
      setState(() { _status = 'logged'; _jwt = token; });
      if (_token.isNotEmpty) await _registerPushToken(_token, token);
    } else {
      setState(() { _status = 'login_failed'; });
      final msg = resp.body;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Login failed: $msg')));
    }
  }

  Future<void> _registerPushToken(String deviceToken, String jwt) async {
    final resp = await http.post(Uri.parse('$SERVER_URL/api/me/push-token'), headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer $jwt' }, body: jsonEncode({ 'token': deviceToken, 'platform': 'android', 'deviceName': 'flutter-test' }));
    if (resp.statusCode == 200) {
      print('Push token registered');
    } else {
      print('Failed to register push token: ${resp.statusCode} ${resp.body}');
    }
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'SecMyNet Mobile',
      home: Scaffold(
        appBar: AppBar(title: Text('SecMyNet Mobile')),
        body: Padding(
          padding: const EdgeInsets.all(16.0),
          child: Column(
            children: [
              Text('Status: $_status'),
              SizedBox(height: 12),
              TextField(key: Key('email'), decoration: InputDecoration(labelText: 'Email'), controller: TextEditingController(text: 'admin@secmynet.com')),
              SizedBox(height: 8),
              TextField(key: Key('password'), decoration: InputDecoration(labelText: 'Password'), controller: TextEditingController(text: 'Admin@123'), obscureText: true),
              SizedBox(height: 12),
              ElevatedButton(onPressed: () async {
                final email = (context.findRenderObject() as RenderObject) == null ? 'admin@secmynet.com' : 'admin@secmynet.com';
                // Very simple: use default admin credentials in fields above for quick test
                await _login('admin@secmynet.com', 'Admin@123');
              }, child: Text('Login (test)')),
              SizedBox(height: 12),
              Text('FCM token: $_token', style: TextStyle(fontSize: 12)),
              SizedBox(height: 12),
              ElevatedButton(onPressed: () async {
                final prefs = await SharedPreferences.getInstance();
                final token = prefs.getString('jwt');
                if (token == null) { ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Login first'))); return; }
                // Example: register phone for SMS fallback
                final resp = await http.post(Uri.parse('$SERVER_URL/api/me/phone'), headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer $token' }, body: jsonEncode({ 'phone': '+10000000000', 'smsOptIn': false }));
                ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Saved phone: ${resp.statusCode}')));
              }, child: Text('Save test phone'))
            ],
          ),
        ),
      ),
    );
  }
}
