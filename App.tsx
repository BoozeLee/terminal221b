// Main App Entry Point

import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ChatScreen } from './src/screens/Chat/ChatScreen';
import { useChatStore } from './src/store/chatStore';

export default function App() {
  const { loadFromStorage } = useChatStore();

  useEffect(() => {
    // Load persisted data on app start
    loadFromStorage();
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" backgroundColor="#0F1419" />
      <ChatScreen />
    </SafeAreaProvider>
  );
}
