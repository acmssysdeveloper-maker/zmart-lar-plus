# Colocar o ZMART Lar+ no ar com dados compartilhados

Hoje o app funciona 100% local: cada navegador guarda sua própria cópia dos dados.
Para que o vendedor lance um pagamento e o comprador veja isso ao recarregar a página
(sem precisar trocar arquivo ou versão), siga os passos abaixo.

## 1. Banco de dados (Supabase)

1. Abra seu projeto em https://supabase.com/dashboard
2. Vá em **SQL Editor → New query**
3. Cole todo o conteúdo do arquivo `supabase-schema.sql` (nesta mesma pasta) e execute (▶ Run)
4. Vá em **Project Settings → API** e copie dois valores:
   - **Project URL** (algo como `https://xxxxx.supabase.co`)
   - **anon / public key** (chave longa, começa com `eyJ...`)

## 2. Configurar o app

Abra o arquivo `config.js` e preencha:

```js
window.ZMART_CONFIG = {
  appName: 'ZMART Lar+',
  demoMode: false,
  supabaseUrl: 'https://xxxxx.supabase.co',      // cole aqui
  supabaseAnonKey: 'eyJ...',                       // cole aqui
  googleClientId: ''
};
```

## 3. Publicar

O app é só HTML/CSS/JS estático — não precisa de build nem servidor. Você pode usar **GitHub Pages**, Vercel, Netlify ou qualquer hospedagem estática. Abaixo, o caminho pelo GitHub (já confirmado: todos os caminhos do app são relativos, funciona em qualquer subcaminho de URL).

### Opção A — GitHub Pages (passo a passo)

1. Crie um repositório novo no GitHub (ex.: `zmart-lar-plus`). Pode ser público — o `config.js` só terá a chave `anon`, que é feita para ser pública.
2. Edite o `config.js` **localmente** (no seu computador) preenchendo `supabaseUrl` e `supabaseAnonKey`, como no passo 2 acima.
3. Envie os arquivos da pasta `zmart-lar-plus/` para a **raiz** do repositório:
   - Pela web: abra o repositório → **Add file → Upload files** → arraste todos os arquivos da pasta (não a pasta em si, o conteúdo dela).
   - Ou via linha de comando: `git init && git add . && git commit -m "app" && git remote add origin <url-do-repo> && git push -u origin main`
4. No repositório, vá em **Settings → Pages**.
5. Em **Source**, escolha a branch `main` e a pasta `/ (root)`. Clique em **Save**.
6. Aguarde cerca de 1 minuto. O GitHub mostra o link, algo como `https://seu-usuario.github.io/zmart-lar-plus/`.
7. Esse é o link que você envia para o vendedor e para o comprador.

**Atualizações depois:** sempre que você quiser mudar algo no app, é só enviar (`git push`) os arquivos atualizados de novo — o GitHub Pages republica sozinho em cerca de 1 minuto.

### Opção B — Vercel/Netlify

Arraste a pasta inteira (`zmart-lar-plus/`) para o painel do Vercel ou Netlify, ou conecte
um repositório Git (inclusive o mesmo do GitHub acima — dá para conectar os dois). Nenhuma
build é necessária. Você recebe um link único (ex.: `https://sua-venda.vercel.app`).

Qualquer que seja a opção, envie o **mesmo link** para o vendedor e para o comprador —
cada um escolhe seu papel na tela de login, como já funciona hoje.


## Como funciona depois de configurado

- **Vendedor lança um pagamento** → o app salva localmente (instantâneo) e envia para o
  Supabase em segundo plano.
- **Comprador abre ou recarrega a página** → o app busca os dados mais recentes da nuvem
  antes de mostrar a tela.
- **Comprovantes (arquivos)**: ficam guardados tanto no aparelho de quem enviou quanto no
  Supabase Storage — assim a outra pessoa consegue baixar o mesmo arquivo mesmo sem
  nunca tê-lo recebido localmente.
- Se a internet cair ou o Supabase não responder, o app **não trava**: continua
  funcionando com os últimos dados que já tinha localmente.

## Sobre segurança

A chave `anon` do Supabase, combinada com as políticas de acesso do `supabase-schema.sql`,
libera leitura e escrita para qualquer pessoa que tenha essa chave — no mesmo nível de
proteção que a senha de tela que o app já usa hoje (`Zmart@123`). Não é uma autenticação
forte. Se no futuro você quiser um controle de acesso mais rígido (login individual por
e-mail/senha, por exemplo), isso pode ser adicionado depois com o Supabase Auth.

## Sincronizar manualmente

Na aba **Dados & Backup**, o card "Sincronização em nuvem" mostra se a conexão está ativa
e tem um botão "sincronizar agora" para forçar a busca imediata, sem esperar recarregar
a página.
