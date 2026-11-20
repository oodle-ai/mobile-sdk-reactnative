// Synthetic data in the shape of the Fieldwork One demo. No real
// people, places or orders.
export type Role = 'driver' | 'dispatcher' | 'admin';
export type User = { id: string; name: string; role: Role };
export type Order = { id: string; customer: string; window: string; status: 'scheduled' | 'en_route' | 'done' };

export const demoUser: User = { id: 'driver-ava', name: 'Ava Chen', role: 'driver' };

export const orders: Order[] = [
  { id: 'FW-1042', customer: 'Harbor Environmental', window: '09:00-10:00', status: 'en_route' },
  { id: 'FW-1043', customer: 'Northside Clinic', window: '10:30-11:30', status: 'scheduled' },
  { id: 'FW-1044', customer: 'Bayview Labs', window: '13:00-14:00', status: 'scheduled' },
  { id: 'FW-1039', customer: 'Pier 7 Storage', window: '08:00-08:30', status: 'done' },
];

export const messages = [
  { id: 'm1', from: 'Dispatch', text: 'FW-1043 asked for a call 10 minutes before arrival.' },
  { id: 'm2', from: 'Dispatch', text: 'Gate code for Bayview Labs is in the order notes.' },
];
