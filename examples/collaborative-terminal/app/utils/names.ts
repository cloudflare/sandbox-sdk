const ADJECTIVES = [
  'brave',
  'calm',
  'clever',
  'cosmic',
  'crystal',
  'daring',
  'eager',
  'fancy',
  'fierce',
  'gentle',
  'golden',
  'happy',
  'icy',
  'jolly',
  'keen',
  'lively',
  'lucky',
  'mighty',
  'noble',
  'plucky',
  'proud',
  'quick',
  'rusty',
  'silent',
  'snappy',
  'swift',
  'vivid',
  'witty',
  'zany',
  'zen'
];

const ANIMALS = [
  'badger',
  'bear',
  'cat',
  'cobra',
  'crane',
  'dolphin',
  'eagle',
  'falcon',
  'fox',
  'hawk',
  'heron',
  'jaguar',
  'koala',
  'lemur',
  'lynx',
  'otter',
  'owl',
  'panda',
  'parrot',
  'penguin',
  'puma',
  'raven',
  'seal',
  'shark',
  'tiger',
  'viper',
  'whale',
  'wolf',
  'wren',
  'zebra'
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function generateName(): string {
  return `${pick(ADJECTIVES)}-${pick(ANIMALS)}`;
}
