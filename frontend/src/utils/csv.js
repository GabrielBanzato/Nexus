/**
 * Exportação de leads para CSV.
 *
 * As primeiras colunas seguem os identificadores reconhecidos pelo Meta Ads na criação de
 * "Público Personalizado" por lista de clientes (phone, ct, st, zip, country). As demais
 * são dados de apoio para a equipe (o Meta permite ignorá-las no mapeamento do upload).
 */
import { normalizarTelefoneWhatsApp } from './whatsapp.js';

/** "R. X, 10 - Centro, Jundiaí - SP, 13201-004" -> { cidade: "Jundiaí", uf: "SP", cep: "13201004" } */
function parseEndereco(endereco) {
  const match = (endereco || '').match(/,\s*([^,]+?)\s*-\s*([A-Z]{2})(?:,\s*(\d{5}-?\d{3}))?\s*$/);
  if (!match) return { cidade: '', uf: '', cep: '' };
  return { cidade: match[1].trim(), uf: match[2], cep: (match[3] || '').replace(/\D/g, '') };
}

const COLUMNS = [
  // --- Identificadores Meta Ads ---
  { header: 'phone', value: (lead) => normalizarTelefoneWhatsApp(lead.phone, lead.address) ?? '' }, // 55 + DDD + número
  { header: 'ct', value: (lead) => parseEndereco(lead.address).cidade },
  { header: 'st', value: (lead) => parseEndereco(lead.address).uf },
  { header: 'zip', value: (lead) => parseEndereco(lead.address).cep },
  { header: 'country', value: () => 'BR' },
  // --- Dados comerciais ---
  { header: 'empresa', value: (lead) => lead.name },
  { header: 'nicho', value: (lead) => lead.category },
  { header: 'telefone', value: (lead) => lead.phone },
  { header: 'endereco', value: (lead) => lead.address },
  { header: 'website', value: (lead) => lead.website },
  { header: 'nota', value: (lead) => lead.rating },
  { header: 'avaliacoes', value: (lead) => lead.reviews_count },
  { header: 'grupo', value: (lead) => lead.lead_group },
  { header: 'status_prospeccao', value: (lead) => lead.status_prospeccao },
  { header: 'google_maps', value: (lead) => lead.maps_url },
];

/**
 * Escapa um valor para CSV (RFC 4180) e neutraliza injeção de fórmula
 * (células iniciadas por = + - @ viram texto no Excel/Sheets).
 */
function escapeCell(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function leadsToCsv(leads) {
  const lines = [
    COLUMNS.map((column) => column.header).join(','),
    ...leads.map((lead) => COLUMNS.map((column) => escapeCell(column.value(lead))).join(',')),
  ];
  return lines.join('\r\n');
}

const slugify = (text) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** nexus-leads-sem-site-pizzaria-2026-09-26.csv */
export function buildCsvFilename({ grupo, nicho } = {}, date = new Date()) {
  const parts = ['nexus-leads', grupo && slugify(grupo), nicho && slugify(nicho), date.toISOString().slice(0, 10)];
  return `${parts.filter(Boolean).join('-')}.csv`;
}

/** Gera o CSV e dispara o download no navegador. */
export function exportLeadsCsv(leads, filters) {
  // BOM: faz o Excel reconhecer UTF-8 (acentos) ao abrir o arquivo com duplo clique.
  const blob = new Blob(['﻿', leadsToCsv(leads)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = buildCsvFilename(filters);
  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
