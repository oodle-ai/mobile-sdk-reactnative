import React, { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { demoUser, orders } from '../model';
import { telemetry } from '../telemetry';

export function Home({ onOpenOrders }: { onOpenOrders: () => void }) {
  useEffect(() => telemetry.ready(), []);
  const next = orders.find((o) => o.status !== 'done');
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Good morning, {demoUser.name.split(' ')[0]}</Text>
      <Text style={styles.sub}>Next stop: {next?.customer} ({next?.window})</Text>
      {/* Large on purpose: CI taps the middle of the screen. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Start shift"
        onPress={() => telemetry.action('Shift started', { stops: orders.length })}
        style={({ pressed }) => [styles.big, pressed && styles.pressed]}>
        <Text style={styles.bigText}>Start shift</Text>
      </Pressable>
      <Pressable accessibilityLabel="Open orders" onPress={onOpenOrders} style={styles.link}>
        <Text style={styles.linkText}>View all orders</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, gap: 12 },
  title: { fontSize: 24, fontWeight: '700', color: '#111' },
  sub: { fontSize: 15, color: '#555' },
  big: { flex: 1, minHeight: 280, borderRadius: 16, backgroundColor: '#1f6feb', alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.8 },
  bigText: { color: 'white', fontSize: 22, fontWeight: '700' },
  link: { padding: 12, alignItems: 'center' },
  linkText: { color: '#1f6feb', fontSize: 16 },
});
