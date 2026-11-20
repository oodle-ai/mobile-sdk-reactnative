import React, { useEffect, useState } from 'react';
import { Pressable, SafeAreaView, StatusBar, StyleSheet, Text, View } from 'react-native';
import { runAutopilot, type Tab } from './src/autopilot';
import { autopilot } from './src/config';
import { demoUser } from './src/model';
import { Comms } from './src/screens/Comms';
import { Home } from './src/screens/Home';
import { More } from './src/screens/More';
import { Orders } from './src/screens/Orders';
import { telemetry } from './src/telemetry';
import { TelemetryProvider } from './src/telemetry/provider';

const TABS: Tab[] = ['Home', 'Orders', 'Comms', 'More'];

// A small copy of the Fieldwork One demo: tabs, one telemetry interface
// for both SDKs, a profile that starts a new session, and a view per tab.
export default function App() {
  const [tab, setTab] = useState<Tab>('Home');
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState('Starting');

  useEffect(() => {
    telemetry
      .initialize(true)
      .then(async (s) => {
        setStatus(s);
        await telemetry.user(demoUser);
      })
      .catch((e) => setStatus(`Telemetry failed: ${String(e)}`))
      .finally(() => setReady(true));
  }, []);

  useEffect(() => {
    if (ready) telemetry.view(`tab-${tab}`, tab);
  }, [ready, tab]);

  useEffect(() => (ready && autopilot ? runAutopilot(setTab) : undefined), [ready]);

  return (
    <TelemetryProvider>
      <SafeAreaView style={styles.root}>
        <StatusBar barStyle="dark-content" />
        <Text style={styles.status} accessibilityLabel="Telemetry status">
          {status}
        </Text>
        <View style={styles.body}>
          {tab === 'Home' && <Home onOpenOrders={() => setTab('Orders')} />}
          {tab === 'Orders' && <Orders />}
          {tab === 'Comms' && <Comms />}
          {tab === 'More' && <More />}
        </View>
        <View style={styles.tabs}>
          {TABS.map((t) => (
            <Pressable key={t} accessibilityRole="tab" accessibilityLabel={t} onPress={() => setTab(t)} style={styles.tab}>
              <Text style={[styles.tabText, t === tab && styles.active]}>{t}</Text>
            </Pressable>
          ))}
        </View>
      </SafeAreaView>
    </TelemetryProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: 'white' },
  status: { fontSize: 12, color: '#777', paddingHorizontal: 16, paddingTop: 8 },
  body: { flex: 1 },
  tabs: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#ccc' },
  tab: { flex: 1, padding: 14, alignItems: 'center' },
  tabText: { color: '#666' },
  active: { color: '#1f6feb', fontWeight: '700' },
});
