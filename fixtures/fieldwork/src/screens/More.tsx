import React, { useEffect, useState } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';
import { telemetry, telemetryName } from '../telemetry';

export function More() {
  const [replay, setReplay] = useState(true);
  const [session, setSession] = useState<string>();
  useEffect(() => {
    telemetry.sessionId().then(setSession);
    telemetry.ready();
  }, []);
  return (
    <View style={styles.screen}>
      <Text style={styles.row}>Telemetry: {telemetryName}</Text>
      <Text style={styles.row}>Session: {session ?? '...'}</Text>
      <View style={styles.toggle}>
        <Text>Session replay</Text>
        <Switch
          accessibilityLabel="Session replay"
          value={replay}
          onValueChange={(v) => {
            setReplay(v);
            void telemetry.replay(v);
          }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, gap: 12 },
  row: { fontSize: 15, color: '#333' },
  toggle: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
});
