import React, { useEffect } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { apiUrl } from '../config';
import { orders } from '../model';
import { telemetry } from '../telemetry';

export function Orders() {
  useEffect(() => {
    // The demo loads orders from its API; a request to the CI collector
    // host gives a resource event with trace headers.
    fetch(`${apiUrl}/orders?driver=driver-ava`)
      .catch(() => undefined)
      .finally(() => telemetry.ready());
  }, []);
  return (
    <FlatList
      contentContainerStyle={styles.list}
      data={orders}
      keyExtractor={(o) => o.id}
      renderItem={({ item }) => (
        <Pressable
          accessibilityLabel={`Order ${item.id}, ${item.customer}`}
          onPress={() => telemetry.action('Order opened', { order: item.id })}
          style={styles.card}>
          <View>
            <Text style={styles.id}>{item.id}</Text>
            <Text style={styles.customer}>{item.customer}</Text>
          </View>
          <Text style={styles.status}>{item.status.replace('_', ' ')}</Text>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  list: { padding: 16, gap: 8 },
  card: { flexDirection: 'row', justifyContent: 'space-between', padding: 14, borderRadius: 12, backgroundColor: '#f2f4f7' },
  id: { fontWeight: '700', color: '#111' },
  customer: { color: '#444' },
  status: { color: '#1f6feb', textTransform: 'capitalize' },
});
