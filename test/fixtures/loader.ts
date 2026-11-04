export default async function load(): Promise<unknown[]> {
  return [
    { id: 'one', url: '/one', title: 'One', text: 'First' },
    { id: 'two', url: '/two', title: 'Two', text: 'Second' },
  ];
}
