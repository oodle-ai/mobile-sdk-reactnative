import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { OodlePrivacy } from '@oodle-ai/mobile-sdk-reactnative';
import { messages } from '../model';
import { telemetry } from '../telemetry';

export function Comms() {
  const [note, setNote] = useState('Gate code 4471');
  useEffect(() => telemetry.ready(), []);
  return (
    <View style={styles.screen}>
      {messages.map((m) => (
        <View key={m.id} style={styles.msg}>
          <Text style={styles.from}>{m.from}</Text>
          <Text>{m.text}</Text>
        </View>
      ))}
      {/* Inputs are masked in replay; this subtree is hidden as a whole. */}
      <OodlePrivacy level="hidden">
        <TextInput value={note} onChangeText={setNote} style={styles.input} accessibilityLabel="Driver note" />
      </OodlePrivacy>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, gap: 8 },
  msg: { padding: 12, borderRadius: 12, backgroundColor: '#eef6ff' },
  from: { fontWeight: '700', marginBottom: 4 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 10 },
});
