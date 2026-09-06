window.ZMART_CONFIG = {
  appName: 'ZMART Lar+',
  demoMode: true,

  // ── Sincronização em nuvem (Supabase) ──────────────────────────────────
  // Preencha os dois campos abaixo para que vendedor e comprador compartilhem
  // os mesmos dados (pagamentos lançados por um aparecem para o outro ao
  // recarregar a página) em vez de cada navegador guardar sua própria cópia.
  //
  // Como obter:
  //   1. Rode o arquivo supabase-schema.sql no SQL Editor do seu projeto Supabase.
  //   2. Vá em Project Settings > API e copie "Project URL" e a chave "anon / public".
  //   3. Cole os dois valores abaixo e publique este arquivo junto com o app.
  //
  // Deixando os dois campos vazios, o app funciona 100% local (como hoje),
  // sem nenhuma dependência de rede.
  supabaseUrl: '',
  supabaseAnonKey: '',

  googleClientId: ''
};
