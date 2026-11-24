import React, { useEffect, useState } from 'react';
import { Pressable, SafeAreaView, StatusBar, StyleSheet, Text, View } from 'react-native';
import { runAutopilot, type Tab } from './src/autopilot';
import { autopilot } from './src/config';
import { demoUser } from './src/model';
import { Comms } from './src/screens/Comms';
import { Home } from './src/screens/Home';
import { More } from './src/screens/More';
import { Orders } from './src/screens/Orders';
import { fetchScenario, NO_SCENARIO, reportReady, runScenario, type Scenario } from './src/scenario';
import { setSdkSettings, type TelemetryProvider as Provider } from './src/config';
import { currentProvider, setReferenceFirst, setProvider, telemetry } from './src/telemetry';
import { setReferenceDebug } from './src/telemetry/reference';
import { TelemetryProvider } from './src/telemetry/provider';

const TABS: Tab[] = ['Home', 'Orders', 'Comms', 'More'];

// A small copy of the Fieldwork One demo: tabs, one telemetry interface
// for both SDKs, a profile that starts a new session, and a view per tab.
export default function App() {
  const [tab, setTab] = useState<Tab>('Home');
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState('Starting');
  const [scenario, setScenario] = useState<Scenario>(NO_SCENARIO);
  // Not known until the scenario is read: it can choose the SDKs.
  const [provider, setProviderState] = useState<Provider | undefined>(undefined);

  useEffect(() => {
    // CI scenarios (scripts/ci/scenarios.sh, scripts/compare/) choose the
    // SDKs, their start order and replay, so the scenario is read before
    // the SDKs start.
    fetchScenario()
      .then((s) => {
        setScenario(s);
        setReferenceFirst(s.order === 'reference-first');
        setReferenceDebug(s.debug === true);
        setSdkSettings(s.settings);
        if (s.provider) setProvider(s.provider);
        setProviderState(currentProvider());
        return telemetry.initialize(true, s.replay);
      })
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

  // After the first view started: the end of the start time of a launch.
  useEffect(() => {
    if (ready) reportReady(scenario);
  }, [ready, scenario]);

  // A scenario run replaces the autopilot, so that each run sends only
  // the events its checks look for.
  useEffect(() => {
    if (!ready) return undefined;
    if (scenario.name !== 'none') return runScenario(scenario, setTab);
    return autopilot ? runAutopilot(setTab) : undefined;
  }, [ready, scenario]);

  return (
    <TelemetryProvider provider={provider ?? 'none'}>
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
