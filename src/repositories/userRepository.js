import bcrypt from 'bcrypt';
import { db } from '../config/database.js';
import { config } from '../config/env.js';

export const ROLES = ['admin', 'partner', 'agent'];

// Nunca selecionar password_hash fora do fluxo de login.
const PUBLIC_COLUMNS = ['id', 'name', 'email', 'role', 'is_active', 'last_login_at', 'created_at', 'updated_at'];

// Hash fixo usado quando o email não existe: o tempo de resposta do login fica igual
// ao de uma senha errada, e não revela quais emails estão cadastrados.
const DUMMY_HASH = bcrypt.hashSync('nexus-dummy-password', 10);

export const hashPassword = (password) => bcrypt.hash(password, config.auth.bcryptRounds);
export const normalizeEmail = (email) => email.trim().toLowerCase();

export function findUserById(id) {
  return db('users').select(PUBLIC_COLUMNS).where({ id }).first();
}

/** @returns {Promise<object|null>} utilizador (sem hash) se as credenciais forem válidas e a conta ativa. */
export async function verifyCredentials(email, password) {
  const user = await db('users').where({ email: normalizeEmail(email) }).first();
  const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok || !user.is_active) return null;

  await db('users').where({ id: user.id }).update({ last_login_at: db.fn.now() });
  const { password_hash: _omit, ...publicUser } = user;
  return publicUser;
}

export async function verifyPassword(userId, password) {
  const row = await db('users').select('password_hash').where({ id: userId }).first();
  return Boolean(row) && bcrypt.compare(password, row.password_hash);
}

export async function createUser({ name, email, password, role }) {
  const [id] = await db('users').insert({
    name: name.trim(),
    email: normalizeEmail(email),
    password_hash: await hashPassword(password),
    role,
  });
  return findUserById(id);
}

export async function updateUser(id, { name, email, role, is_active: isActive, password }) {
  const changes = {};
  if (name !== undefined) changes.name = name.trim();
  if (email !== undefined) changes.email = normalizeEmail(email);
  if (role !== undefined) changes.role = role;
  if (isActive !== undefined) changes.is_active = isActive;
  if (password !== undefined) changes.password_hash = await hashPassword(password);

  if (Object.keys(changes).length) await db('users').where({ id }).update(changes);
  return findUserById(id);
}

export async function listUsers({ role, active, limit, offset }) {
  const query = db('users');
  if (role) query.where({ role });
  if (active !== undefined) query.where({ is_active: active });

  const [{ total }] = await query.clone().count({ total: '*' });
  const data = await query.clone().select(PUBLIC_COLUMNS).orderBy('name').limit(limit).offset(offset);
  return { data, meta: { total: Number(total), limit, offset } };
}

/** Lista mínima (id, nome, papel) de utilizadores ativos, para selects de atribuição. */
export function listUserDirectory() {
  return db('users').select('id', 'name', 'role').where({ is_active: true }).orderBy('name');
}

export async function countActiveAdmins({ excludingId } = {}) {
  const query = db('users').where({ role: 'admin', is_active: true });
  if (excludingId) query.whereNot({ id: excludingId });
  const [{ total }] = await query.count({ total: '*' });
  return Number(total);
}

/**
 * Cria o primeiro admin a partir das variáveis de ambiente se não houver nenhum utilizador.
 * Sem utilizadores e sem ADMIN_PASSWORD ninguém conseguiria entrar: isso é fatal.
 */
export async function ensureBootstrapAdmin(logger) {
  const [{ total }] = await db('users').count({ total: '*' });
  if (Number(total) > 0) return;

  const { adminEmail, adminName, adminPassword } = config.auth;
  if (!adminPassword) {
    throw new Error('Nenhum utilizador cadastrado. Defina ADMIN_PASSWORD (e ADMIN_EMAIL) para criar o primeiro admin.');
  }

  await createUser({ name: adminName, email: adminEmail, password: adminPassword, role: 'admin' });
  logger.info({ email: adminEmail }, 'Primeiro admin criado a partir de ADMIN_EMAIL/ADMIN_PASSWORD');
}
