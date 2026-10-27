export const STICKERS = [
    { id: 'happy', zh: '开心', en: 'Happy', url: new URL('../../assets/stickers/happy.png', import.meta.url).href },
    { id: 'laugh', zh: '笑哭', en: 'LOL', url: new URL('../../assets/stickers/laugh.png', import.meta.url).href },
    { id: 'cry', zh: '委屈', en: 'Crying', url: new URL('../../assets/stickers/cry.png', import.meta.url).href },
    { id: 'angry', zh: '生气', en: 'Angry', url: new URL('../../assets/stickers/angry.png', import.meta.url).href },
    { id: 'wow', zh: '震惊', en: 'Wow', url: new URL('../../assets/stickers/wow.png', import.meta.url).href },
    { id: 'love', zh: '比心', en: 'Love', url: new URL('../../assets/stickers/love.png', import.meta.url).href },
    { id: 'like', zh: '点赞', en: 'Nice', url: new URL('../../assets/stickers/like.png', import.meta.url).href },
    { id: 'sleepy', zh: '困了', en: 'Sleepy', url: new URL('../../assets/stickers/sleepy.png', import.meta.url).href },
    { id: 'confused', zh: '疑惑', en: 'Confused', url: new URL('../../assets/stickers/confused.png', import.meta.url).href },
    { id: 'awkward', zh: '尴尬', en: 'Awkward', url: new URL('../../assets/stickers/awkward.png', import.meta.url).href },
    { id: 'fish', zh: '摸鱼', en: 'Slacking', url: new URL('../../assets/stickers/fish.png', import.meta.url).href },
    { id: 'coffee', zh: '续命咖啡', en: 'Need coffee', url: new URL('../../assets/stickers/coffee.png', import.meta.url).href },
    { id: 'melt', zh: '融化了', en: 'Melting', url: new URL('../../assets/stickers/melt.png', import.meta.url).href },
    { id: 'broken', zh: '裂开', en: 'Broken', url: new URL('../../assets/stickers/broken.png', import.meta.url).href },
    { id: 'party', zh: '庆祝', en: 'Party', url: new URL('../../assets/stickers/party.png', import.meta.url).href },
    { id: 'okay', zh: '没问题', en: 'All good', url: new URL('../../assets/stickers/okay.png', import.meta.url).href },
    { id: 'doge', zh: '狗头', en: 'Doge', url: new URL('../../assets/stickers/doge.png', import.meta.url).href }
];

const stickers = new Map(STICKERS.map(sticker => [sticker.id, sticker]));
export const stickerById = id => typeof id === 'string' ? stickers.get(id) : undefined;
