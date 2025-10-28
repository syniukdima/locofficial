let ws = null;
let wsUrl = import.meta.env.VITE_REALTIME_URL || '/ws';
let currentProfile = null;
let yourId = null;
let gamePublic = {};
let yourHand = [];
let sender = null;
let view = 'lobby'; // 'lobby' | 'game'

export function getWs() { return ws; }
export function setWs(v) { ws = v; }

export function getWsUrl() { return wsUrl; }
export function setWsUrl(v) { wsUrl = v; }

export function getCurrentProfile() { return currentProfile; }
export function setCurrentProfile(p) { currentProfile = p; }

export function getYourId() { return yourId; }
export function setYourId(id) { yourId = id; }

export function getGamePublic() { return gamePublic; }
export function setGamePublic(v) { gamePublic = v || {}; }

export function getYourHand() { return yourHand; }
export function setYourHand(v) { yourHand = Array.isArray(v) ? v : []; }

export function setSender(fn) { sender = fn; }
export function getSender() { return sender; }

export function getView() { return view; }
export function setView(v) { view = v; }




