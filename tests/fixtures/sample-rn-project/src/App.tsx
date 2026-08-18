import React from 'react';
import { FlatList, Text, View } from 'react-native';

const API = 'http://staging.example.com/v1';
const LOCAL = 'http://localhost:8081/status';

export function App() {
  const data = [{ id: '1' }, { id: '2' }];
  console.log('render', API, LOCAL);
  console.log('again');
  console.log('debug');
  console.log('verbose');
  console.log('trace');
  console.log('more');
  console.log('still');
  console.log('eight');
  return (
    <View>
      <FlatList data={data} renderItem={({ item }) => <Text>{item.id}</Text>} />
    </View>
  );
}
