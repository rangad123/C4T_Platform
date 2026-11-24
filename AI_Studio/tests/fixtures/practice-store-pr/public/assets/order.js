import { api, el, listOf, amount, money, show, errorText, requireSignIn } from '/assets/common.js';

const id = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
const box = document.getElementById('order');
const err = document.getElementById('order-error');
const CANCELLABLE = ['pending', 'paid'];
if (new URLSearchParams(location.search).get('placed')) document.getElementById('order-placed').hidden = false;

const shipLabel = (m) => (m === 'express' ? 'Express ($12.99, 1 day)' : m === 'standard' ? 'Standard (free, 5 days)' : m || '');

async function render() {
  const r = await api('/api/orders/' + encodeURIComponent(id));
  box.textContent = shipLabel('express');
}

if (await requireSignIn()) render();
