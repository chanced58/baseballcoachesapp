import { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, KeyboardAvoidingView, Platform } from 'react-native';
import { router } from 'expo-router';
import { getSupabaseClient } from '../../src/lib/supabase';

export default function SignInScreen() {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const supabase = getSupabaseClient();

  async function handleSignIn() {
    if (!email.trim()) return;
    setLoading(true);
    setError(null);

    const { error: signInError } = await supabase.auth.signInWithOtp({
      email: email.toLowerCase().trim(),
      options: {
        emailRedirectTo: 'baseballcoaches://auth-callback',
      },
    });

    if (signInError) {
      setError(signInError.message);
    } else {
      setSent(true);
    }
    setLoading(false);
  }

  async function handleVerifyCode() {
    if (!code.trim()) return;
    setVerifying(true);
    setError(null);

    const { error: verifyError } = await supabase.auth.verifyOtp({
      email: email.toLowerCase().trim(),
      token: code.trim(),
      type: 'email',
    });

    if (verifyError) {
      setError(verifyError.message);
    }
    // On success, AuthProvider's onAuthStateChange picks up the new session
    // and (auth)/_layout.tsx redirects to (tabs) automatically.
    setVerifying(false);
  }

  if (sent) {
    return (
      <KeyboardAvoidingView
        className="flex-1 bg-brand-900"
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-5xl mb-4">📧</Text>
          <Text className="text-white text-2xl font-bold mb-2">Check your email</Text>
          <Text className="text-blue-300 text-center mb-8">
            We sent a code to {email}. Tap the link, or enter the code below.
          </Text>

          <View className="w-full mb-4">
            <Text className="text-blue-200 text-sm font-medium mb-1">Verification code</Text>
            <TextInput
              className="bg-white/10 border border-white/20 rounded-xl px-4 py-3.5 text-white text-base text-center tracking-widest"
              placeholder="Enter code"
              placeholderTextColor="rgba(147,197,253,0.5)"
              value={code}
              onChangeText={setCode}
              keyboardType="number-pad"
              maxLength={16}
            />
          </View>

          {error && (
            <View className="w-full bg-red-500/20 border border-red-400/30 rounded-xl px-4 py-3 mb-4">
              <Text className="text-red-300 text-sm">{error}</Text>
            </View>
          )}

          <TouchableOpacity
            className={`w-full bg-white rounded-xl py-3.5 items-center mb-4 ${
              verifying || !code.trim() ? 'opacity-50' : ''
            }`}
            onPress={handleVerifyCode}
            disabled={verifying || !code.trim()}
          >
            <Text className="text-brand-700 font-bold text-base">
              {verifying ? 'Verifying...' : 'Verify code'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => {
              setSent(false);
              setCode('');
              setError(null);
            }}
          >
            <Text className="text-blue-300 underline text-sm">Use a different email</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    );
  }

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-brand-900"
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View className="flex-1 items-center justify-center px-6">
        <Text className="text-white text-3xl font-bold mb-2">DiamondOS</Text>
        <Text className="text-blue-300 mb-10">Sign in to your account</Text>

        <View className="w-full mb-4">
          <Text className="text-blue-200 text-sm font-medium mb-1">Email address</Text>
          <TextInput
            className="bg-white/10 border border-white/20 rounded-xl px-4 py-3.5 text-white text-base"
            placeholder="coach@school.edu"
            placeholderTextColor="rgba(147,197,253,0.5)"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        {error && (
          <View className="w-full bg-red-500/20 border border-red-400/30 rounded-xl px-4 py-3 mb-4">
            <Text className="text-red-300 text-sm">{error}</Text>
          </View>
        )}

        <TouchableOpacity
          className={`w-full bg-white rounded-xl py-3.5 items-center ${
            loading || !email ? 'opacity-50' : ''
          }`}
          onPress={handleSignIn}
          disabled={loading || !email.trim()}
        >
          <Text className="text-brand-700 font-bold text-base">
            {loading ? 'Sending...' : 'Send magic link'}
          </Text>
        </TouchableOpacity>

        <Text className="text-blue-400 text-xs text-center mt-6">
          No password needed. We'll email you a link and a code.
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}
