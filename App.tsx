// Main App Entry Point

import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ChatScreen } from './src/screens/Chat/ChatScreen';
import { useChatStore } from './src/store/chatStore';

export default function App() {
  const { loadFromStorage } = useChatStore();

  useEffect(() => {
    void loadFromStorage();
  }, [loadFromStorage]);

  return (
    <SafeAreaProvider>
      {/* No backgroundColor: expo-status-bar dropped the prop in SDK 56 and its
          StatusBar now accepts only style, hideTransitionAnimation, animated and
          hidden. The bar takes the app's own background, which is the point of
          edge-to-edge — the prop was removed because there is nothing left for it
          to override. */}
      <StatusBar style="light" />
      <ChatScreen />
    </SafeAreaProvider>
  );
}
