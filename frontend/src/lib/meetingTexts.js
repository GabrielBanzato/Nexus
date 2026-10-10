/**
 * Pré-visualização das mensagens de reunião que o SERVIDOR envia ao cliente
 * (backend: services/meetingNotifier.js). Manter os dois iguais: a pessoa vê aqui exatamente o
 * que o cliente vai receber (por baixo da assinatura "*Nome*").
 */

const previewDate = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' });
const previewTime = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });

/** Primeiro nome para cumprimentar; nunca o nome da empresa nem um número. */
export function greetingName({ contactName, company } = {}) {
  const name = String(contactName ?? '').trim();
  if (!name || /^[+\d(]/.test(name)) return null;
  if (company && name.toLowerCase() === String(company).trim().toLowerCase()) return null;
  return name.split(/\s+/)[0];
}

const hi = (name) => `Oi${name ? `, ${name}` : ''}!`;

export function instantInvitePreview({ name, link }) {
  return [
    `${hi(name)} Que tal a gente continuar essa conversa por vídeo? Fica bem mais fácil eu te mostrar tudo com calma 🙂`,
    `É só tocar no link abaixo, pelo celular ou pelo computador. Não precisa instalar nada nem criar conta:\n${link}`,
    'Já estou te esperando na sala!',
  ].join('\n\n');
}

export function confirmationPreview({ name, when, link }) {
  return [
    `${hi(name)} Combinado: nossa conversa por vídeo fica marcada para *${previewDate.format(when)}, às ${previewTime.format(when)}* ✅`,
    `Na hora, é só tocar neste link (funciona no celular ou no computador, sem instalar nada):\n${link}`,
    'Vou te lembrar no dia e uma hora antes. Se precisar mudar o horário, é só me chamar aqui!',
  ].join('\n\n');
}
