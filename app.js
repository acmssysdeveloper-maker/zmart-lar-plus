(() => {
  'use strict';

  // ============================================================
  // VERSÃO / BUILD — atualize este valor a cada deploy. Aparece no rodapé do menu
  // lateral e na página "Dados & Backup", para confirmar visualmente, dentro do
  // próprio app, se a atualização mais recente já está no ar (sem depender do GitHub).
  // ============================================================
  const APP_VERSION = 'v7.4';
  const APP_BUILD = '2026-09-07 · gráfico entrada parcial + botões próximo passo';

  // ============================================================
  // SINCRONIZAÇÃO EM NUVEM (Supabase) — opcional.
  // Se window.ZMART_CONFIG.supabaseUrl e .supabaseAnonKey estiverem preenchidos (config.js),
  // o app passa a: (1) buscar os dados mais recentes da nuvem a cada carregamento da página,
  // e (2) enviar cada alteração para a nuvem em segundo plano, além de manter a cópia local
  // (localStorage/IndexedDB) como cache — o app continua funcionando normalmente offline ou
  // sem credenciais configuradas (modo local, como antes).
  // ============================================================
  function supabaseConfigured(){ return !!(window.ZMART_CONFIG?.supabaseUrl && window.ZMART_CONFIG?.supabaseAnonKey); }
  function sbHeaders(extra={}){ const k=window.ZMART_CONFIG.supabaseAnonKey; return {apikey:k,Authorization:'Bearer '+k,...extra}; }
  async function sbFetch(path,opts={}){
    const url=window.ZMART_CONFIG.supabaseUrl.replace(/\/$/,'')+path;
    const headers=sbHeaders({'Content-Type':'application/json',...(opts.prefer?{Prefer:opts.prefer}:{})});
    const res=await fetch(url,{method:opts.method||'GET',headers,body:opts.body});
    if(!res.ok){ const body=await res.text().catch(()=>''); throw new Error(`Supabase ${opts.method||'GET'} ${path} falhou (${res.status}): ${body.slice(0,200)}`); }
    return res.status===204?null:res.json().catch(()=>null);
  }
  // Conversão de colunas snake_case (banco) <-> camelCase (app), nos dois sentidos.
  function installmentToRow(saleId,i){
    return {id:i.id,sale_id:saleId,type:i.type,number:Number(i.number||0),label:i.label,due_date:i.dueDate,value:Number(i.value)||0,
      status:i.status,received:Number(i.received)||0,paid_at:i.paidAt||null,note:i.note||'',schedule_year:Number(i.scheduleYear||0),
      history:Array.isArray(i.history)?i.history:[],receipt:i.receipt||null,paid_late:!!i.paidLate,
      late_days_on_payment:Number(i.lateDaysOnPayment||0),late_interest_charged:Number(i.lateInterestCharged||0)};
  }
  function rowToInstallment(r){
    return {id:r.id,type:r.type,number:Number(r.number||0),label:r.label,dueDate:r.due_date,value:Number(r.value)||0,status:r.status,
      received:Number(r.received)||0,paidValue:Number(r.received)||0,paidAt:r.paid_at||'',note:r.note||'',scheduleYear:Number(r.schedule_year||0),
      history:Array.isArray(r.history)?r.history:[],receipt:r.receipt||null,paidLate:!!r.paid_late,
      lateDaysOnPayment:Number(r.late_days_on_payment||0),lateInterestCharged:Number(r.late_interest_charged||0)};
  }
  // Envia TODAS as vendas locais para a nuvem (upsert das vendas + diff de parcelas/entrada por venda).
  // "Melhor esforço": roda em segundo plano; se falhar, a cópia local (fonte da sessão atual) não é afetada.
  async function pushSalesToSupabase(){
    if(!supabaseConfigured()) return;
    const localSaleIds=new Set(state.sales.map(s=>s.id));
    // Delete Supabase sales that no longer exist locally (removes duplicates)
    const remoteSales=await sbFetch('/rest/v1/sales?select=id',{method:'GET'})||[];
    const remoteOrphans=remoteSales.map(r=>r.id).filter(id=>!localSaleIds.has(id));
    if(remoteOrphans.length){
      await sbFetch(`/rest/v1/installments?sale_id=in.(${remoteOrphans.map(encodeURIComponent).join(',')})`,{method:'DELETE',prefer:'return=minimal'});
      await sbFetch(`/rest/v1/sales?id=in.(${remoteOrphans.map(encodeURIComponent).join(',')})`,{method:'DELETE',prefer:'return=minimal'});
    }
    for(const sale of state.sales){
      await sbFetch('/rest/v1/sales?on_conflict=id',{method:'POST',prefer:'resolution=merge-duplicates,return=minimal',
        body:JSON.stringify([{id:sale.id,property:sale.property,schedule:sale.schedule,audit:sale.audit,settings:sale.settings,
          seller_password:sale.sellerPassword||'Zmart@123',buyer_password:sale.buyerPassword||'Zmart@123',updated_at:new Date().toISOString()}])});
      const existing=await sbFetch(`/rest/v1/installments?select=id&sale_id=eq.${encodeURIComponent(sale.id)}`,{method:'GET'})||[];
      const localIds=new Set(sale.installments.map(i=>i.id));
      const idsToDelete=existing.map(r=>r.id).filter(id=>!localIds.has(id));
      if(idsToDelete.length) await sbFetch(`/rest/v1/installments?id=in.(${idsToDelete.map(encodeURIComponent).join(',')})`,{method:'DELETE',prefer:'return=minimal'});
      if(sale.installments.length) await sbFetch('/rest/v1/installments?on_conflict=id',{method:'POST',prefer:'resolution=merge-duplicates,return=minimal',
        body:JSON.stringify(sale.installments.map(i=>installmentToRow(sale.id,i)))});
    }
  }
  // Busca o estado mais atual da nuvem. Retorna null se não configurado, sem dados, ou em falha de rede
  // (nesse caso o app segue com a cópia local — nunca trava a tela por causa da nuvem).
  async function pullStateFromSupabase(){
    if(!supabaseConfigured()) return null;
    try{
      const [salesRows,instRows]=await Promise.all([
        sbFetch('/rest/v1/sales?select=*',{method:'GET'}),
        sbFetch('/rest/v1/installments?select=*',{method:'GET'})
      ]);
      if(!Array.isArray(salesRows)||!salesRows.length) return null;
      const byId={}; (instRows||[]).forEach(r=>{(byId[r.sale_id]=byId[r.sale_id]||[]).push(rowToInstallment(r));});
      const allSales=salesRows.map(r=>({id:r.id,property:r.property,schedule:r.schedule,audit:r.audit||[],settings:r.settings||{},
        sellerPassword:r.seller_password||'Zmart@123',buyerPassword:r.buyer_password||'Zmart@123',
        installments:byId[r.id]||[],receiptInbox:[],createdAt:r.created_at,updatedAt:r.updated_at}));
      // Deduplicate: if same property title+total appears more than once, keep only the one with most payments (received > 0) or latest updatedAt
      const seenTitles=new Map();
      const sales=[];
      for(const s of allSales){
        const key=(s.property?.title||'')+'|'+(s.property?.total||'');
        const existing=seenTitles.get(key);
        if(!existing){ seenTitles.set(key,s); sales.push(s); }
        else {
          // Keep the one with more payments
          const sPaid=(s.installments||[]).filter(i=>i.status==='paid').length;
          const ePaid=(existing.installments||[]).filter(i=>i.status==='paid').length;
          if(sPaid>ePaid||(sPaid===ePaid&&(s.updatedAt||'')>(existing.updatedAt||''))){
            const idx=sales.indexOf(existing); if(idx>=0) sales.splice(idx,1,s); seenTitles.set(key,s);
          }
        }
      }
      const bestActive=sales.find(s=>s.installments.some(i=>i.status==='paid'))?.id||sales[0].id;
      return {version:STATE_VERSION,activeSaleId:bestActive,sales,updatedAt:new Date().toISOString()};
    }catch(err){ console.warn('Falha ao buscar dados da nuvem, mantendo cópia local:',err.message); return null; }
  }
  // Dispara o envio em segundo plano (nunca bloqueia a interface; falhas só geram aviso no console).
  function queueCloudSync(){ if(supabaseConfigured()&&!_bootSyncing) pushSalesToSupabase().catch(err=>console.warn('Sincronização com a nuvem falhou:',err.message)); }

  const DATA_KEY = 'zmart_lar_plus_data_v5';
  const STATE_VERSION = 10; // v10: garante que o seed reflita o Contrato Kayo × Jussara mesmo com estado de demonstração antigo.
  const ROLE_KEY = 'zmart_lar_plus_role_v5';
  const USERS = {
    vendedor: { pass: 'Zmart@123', label: 'Vendedor · ADM' },
    comprador: { pass: 'Zmart@123', label: 'Comprador · Acompanhamento' }
  };

  let role = localStorage.getItem(ROLE_KEY) || null;
  let currentPage = 'dashboard';
  let modalCleanup = null;
  let toastTimer = null;
  let installmentFilter = 'todos';
  let paymentFilter = 'todos';

  const $ = (s, root=document) => root.querySelector(s);
  const $$ = (s, root=document) => [...root.querySelectorAll(s)];
  // Must be initialized before loadState()/normalizeState() can call seedState().
  const uid = () => 'z_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const today = () => new Date().toISOString().slice(0,10);
  const money = v => new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(Number(v)||0);
  const dateBR = v => v ? new Intl.DateTimeFormat('pt-BR').format(new Date(v+'T00:00:00')) : '—';
  const pct = (a,b) => b ? Math.max(0, Math.min(100, Number(a)/Number(b)*100)) : 0;
  const esc = v => String(v ?? '').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;',"\"":'&quot;'}[c]));
  const addMonths = (date, months) => { const d = new Date(date); d.setMonth(d.getMonth()+months); return d; };
  const iso = d => d.toISOString().slice(0,10);

  let _bootSyncing = true; // suppress cloud push during boot init
  let state = loadState();
  activateSale(state.activeSaleId);
  if(!localStorage.getItem(DATA_KEY)){ try{const old=JSON.parse(localStorage.getItem('zmart_lar_plus_data_v4')||'null'); if(old){state=normalizeState(old);saveState();}}catch{} }
  ensureV5State();
  _bootSyncing = false;
  function splitExact(total,count){
    total=Math.max(0,Number(total)||0); count=Math.max(0,Number(count)||0);
    if(!count) return [];
    const cents=Math.round(total*100), base=Math.floor(cents/count), rest=cents-base*count;
    return Array.from({length:count},(_,idx)=>(base+(idx===count-1?rest:0))/100);
  }
  function clampDay(year,month,day){
    const last=new Date(year,month+1,0).getDate();
    return Math.min(Math.max(1,Number(day)||1),last);
  }
  function dueDateByMonth(baseDate, offsetMonths, paymentDay){
    const d=new Date((baseDate||today())+'T00:00:00'); d.setDate(1); d.setMonth(d.getMonth()+Number(offsetMonths||0));
    d.setDate(clampDay(d.getFullYear(),d.getMonth(),paymentDay||new Date((baseDate||today())+'T00:00:00').getDate())); return iso(d);
  }
  function defaultAnnualPlans(parcelTotal,parcelCount){
    parcelTotal=Math.max(0,Number(parcelTotal)||0); parcelCount=Math.max(0,Math.floor(Number(parcelCount)||0));
    if(!parcelCount)return [];
    const years=Math.ceil(parcelCount/12), counts=[]; let rem=parcelCount;
    for(let y=1;y<=years;y++){const n=Math.min(12,rem);counts.push(n);rem-=n;}
    const values=splitExact(parcelTotal,years);
    return counts.map((count,idx)=>({year:idx+1,count,value:count?Number((values[idx]/count).toFixed(2)):0}));
  }
  function normalizeAnnualPlans(plans, parcelTotal=0, parcelCount=0){
    const arr=Array.isArray(plans)?plans:[]; const out=arr.map((r,i)=>({year:Number(r?.year)||i+1,count:Math.max(0,Math.floor(Number(r?.count)||0)),value:Math.max(0,Number(r?.value)||0)})).filter(r=>r.count>0);
    return out.length?out:defaultAnnualPlans(parcelTotal,parcelCount);
  }
  function annualPlanTotals(plans){
    return (plans||[]).reduce((a,r)=>({count:a.count+Number(r.count||0),total:a.total+(Number(r.count||0)*Number(r.value||0))}),{count:0,total:0});
  }
  function makeInstallments(entryTotal=50000, entryCount=5, firstDueDate=today(), rules={}){
    const parcelCount=Math.max(0,Math.floor(Number(rules.parcelCount)||0));
    const paymentDay=Math.max(1,Math.min(31,Math.floor(Number(rules.paymentDayLimit)||new Date(firstDueDate+'T00:00:00').getDate())));
    const plans=normalizeAnnualPlans(rules.annualPlans,Math.max(0,Number(rules.totalParcelValue)||0),parcelCount);
    const installments=[], entries=splitExact(entryTotal,entryCount);
    for(let i=1;i<=entryCount;i++) installments.push({id:uid(),type:'entrada',number:i,label:`Entrada ${String(i).padStart(2,'0')}`,dueDate:dueDateByMonth(firstDueDate,i-1,paymentDay),value:entries[i-1],status:'pending',received:0,paidValue:0,paidAt:'',receipt:null,note:''});
    // Por padrão as parcelas começam após as entradas (offset = entryCount).
    // parcelStartOffset permite alinhar a 1ª parcela ao primeiro vencimento (ex.: contrato com sinal pago à parte).
    let parcelNo=1, monthOffset=(rules.parcelStartOffset!=null)?Math.max(0,Math.floor(Number(rules.parcelStartOffset))):entryCount;
    plans.forEach((plan,yearIndex)=>{
      for(let j=0;j<plan.count;j++){
        const yearValue=Math.max(0,Number(plan.value)||0);
        installments.push({id:uid(),type:'parcela',number:parcelNo,label:`Parcela ${String(parcelNo).padStart(2,'0')}`,dueDate:dueDateByMonth(firstDueDate,monthOffset,paymentDay),value:yearValue,status:'pending',received:0,paidValue:0,paidAt:'',receipt:null,note:'',scheduleYear:yearIndex+1});
        parcelNo++; monthOffset++;
      }
    });
    return installments;
  }
  function inferAnnualPlans(installments){
    const parcels=(installments||[]).filter(i=>i.type==='parcela').sort((a,b)=>a.dueDate.localeCompare(b.dueDate));
    if(!parcels.length)return [];
    const groups=[]; parcels.forEach((i,idx)=>{const year=Math.floor(idx/12)+1;let g=groups.find(x=>x.year===year);if(!g){g={year,count:0,total:0};groups.push(g);}g.count++;g.total+=Number(i.value)||0;});
    return groups.map(g=>({year:g.year,count:g.count,value:g.count?Number((g.total/g.count).toFixed(2)):0}));
  }
  function seedSale(title='Venda do imóvel', total=350000, entryTotal=50000, parcelCount=60, entryCount=5, firstDueDate=today()){
    const parcelTotal=Math.max(0,total-entryTotal), annualPlans=defaultAnnualPlans(parcelTotal,parcelCount), paymentDay=new Date(firstDueDate+'T00:00:00').getDate();
    const schedule={entryCount,parcelCount,firstDueDate,paymentDayLimit:paymentDay,lateInterestRate:0,lateInterestPeriod:'monthly',annualPlans};
    return {id:uid(),property:{title,total,entryTotal,description:'Acompanhamento financeiro da compra e venda'},sellerPassword:'Zmart@123',buyerPassword:'Zmart@123',installments:makeInstallments(entryTotal,entryCount,firstDueDate,{...schedule,totalParcelValue:parcelTotal}),receiptInbox:[],audit:[],settings:{validationTolerance:0.01,maxFileMB:20,ocrLanguage:'por'},schedule,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  }
  function normalizeInstallments(list){
    return (Array.isArray(list)?list:[]).map(i=>{
      const value=Number(i.value)||0;
      // Compatibilidade com registros antigos (só tinham status paid/pending + paidValue): se não houver
      // campo "received" explícito, deriva do status legado.
      let received=Number(i.received);
      if(!Number.isFinite(received)) received=i.status==='paid'?Number(i.paidValue||value)||0:0;
      received=Number(received.toFixed(2));
      return {id:i.id||uid(),type:i.type==='entrada'?'entrada':'parcela',number:Number(i.number||0),label:i.label||(i.type==='entrada'?'Entrada':'Parcela'),dueDate:i.dueDate||today(),value,status:installmentStatus(value,received),received,paidValue:received,paidAt:i.paidAt||'',receipt:i.receipt||null,note:i.note||'',scheduleYear:Number(i.scheduleYear||0),history:Array.isArray(i.history)?i.history:[]};
    });
  }
  // Garante que exista EXATAMENTE um lançamento de entrada por venda, com valor = property.entryTotal.
  // Se já existirem vários (de cadastros antigos), mescla-os em um só, somando o recebido e o histórico —
  // nada de pagamento se perde. O comprador tem UM valor de entrada, pago de forma parcial, com data limite única.
  function consolidateEntrada(installments, entryTotal, fallbackDate){
    const entradas=installments.filter(i=>i.type==='entrada').sort((a,b)=>(a.dueDate||'').localeCompare(b.dueDate||''));
    const others=installments.filter(i=>i.type!=='entrada');
    const value=Math.max(0,Number(entryTotal)||0);
    if(value<=0.009) return others; // esta venda não tem entrada
    if(!entradas.length){
      return [...others,{id:uid(),type:'entrada',number:1,label:'Entrada',dueDate:fallbackDate||today(),value,status:'pending',received:0,paidValue:0,paidAt:'',receipt:null,note:'',scheduleYear:0,history:[]}];
    }
    const principal={...entradas[0]};
    let received=0,history=[],paidAtMax='',receipt=null,notes=[];
    entradas.forEach(e=>{
      received=Number((received+Number(e.received||e.paidValue||0)).toFixed(2));
      if(Array.isArray(e.history)&&e.history.length) history=history.concat(e.history);
      if(!receipt&&e.receipt) receipt=e.receipt;
      if(e.paidAt&&e.paidAt>paidAtMax) paidAtMax=e.paidAt;
      if(e.note&&!notes.includes(e.note)) notes.push(e.note);
    });
    received=Math.min(received,value);
    principal.label='Entrada'; principal.number=1; principal.value=value; principal.received=received; principal.paidValue=received;
    principal.paidAt=paidAtMax||principal.paidAt||''; principal.receipt=receipt; principal.note=notes.join(' · '); principal.history=history;
    principal.status=installmentStatus(value,received);
    return [...others,principal];
  }
  function normalizeSale(s){
    const total=Number(s?.property?.total)||0, entryTotal=Number(s?.property?.entryTotal)||0;
    const installments=consolidateEntrada(normalizeInstallments(s?.installments),entryTotal,s?.schedule?.firstDueDate);
    const entries=installments.filter(i=>i.type==='entrada').length, parcels=installments.filter(i=>i.type==='parcela').length;
    const oldSchedule=s?.schedule||{}; const firstDueDate=oldSchedule.firstDueDate||installments.find(i=>i.dueDate)?.dueDate||today();
    const paymentDayLimit=Math.max(1,Math.min(31,Number(oldSchedule.paymentDayLimit)||new Date(firstDueDate+'T00:00:00').getDate()));
    const annualPlans=normalizeAnnualPlans(oldSchedule.annualPlans?.length?oldSchedule.annualPlans:inferAnnualPlans(installments),total-entryTotal,Number(oldSchedule.parcelCount??parcels));
    return {id:s?.id||uid(),property:{title:s?.property?.title||'Venda do imóvel',total,entryTotal,description:s?.property?.description||''},
      sellerPassword:s?.sellerPassword||'Zmart@123',buyerPassword:s?.buyerPassword||'Zmart@123',
      installments,receiptInbox:Array.isArray(s?.receiptInbox)?s.receiptInbox:[],audit:Array.isArray(s?.audit)?s.audit:[],settings:{validationTolerance:Number(s?.settings?.validationTolerance??0.01),maxFileMB:Number(s?.settings?.maxFileMB??20),ocrLanguage:s?.settings?.ocrLanguage||'por'},schedule:{entryCount:Number(oldSchedule.entryCount??entries),parcelCount:Number(oldSchedule.parcelCount??parcels),firstDueDate,paymentDayLimit,lateInterestRate:Math.max(0,Number(oldSchedule.lateInterestRate)||0),lateInterestPeriod:oldSchedule.lateInterestPeriod==='daily'?'daily':'monthly',entryDeadline:oldSchedule.entryDeadline||'',annualPlans},createdAt:s?.createdAt||new Date().toISOString(),updatedAt:s?.updatedAt||new Date().toISOString()};
  }
  function activateSale(id){
    const sale=state.sales.find(x=>x.id===id)||state.sales[0];
    if(!sale) return;
    state.activeSaleId=sale.id; state.property=sale.property; state.installments=sale.installments; state.receiptInbox=sale.receiptInbox; state.audit=sale.audit; state.settings=sale.settings; state.schedule=sale.schedule;
    state.sellerPassword=sale.sellerPassword||'Zmart@123'; state.buyerPassword=sale.buyerPassword||'Zmart@123';
  }
  function seedContractSale(){
    // Contrato Particular de Compra e Venda — Jussara Regina Zayat × Kayo de Souza Almeida (Magé/RJ).
    // Opção A: "valor do imóvel" no app = valor total do contrato (R$ 79.608), de modo que
    // saldo das parcelas (79.608 − 10.000 = 69.608) feche exatamente com o cronograma progressivo,
    // respeitando a regra de consistência interna do app sem alterar a trava.
    const total=79608, entryTotal=10000, entryCount=1, firstDueDate='2026-07-10', paymentDay=10;
    const annualPlans=[
      {year:1,count:6, value:1000}, // Jul–Dez/2026
      {year:2,count:12,value:1045}, // Jan–Dez/2027
      {year:3,count:12,value:1092}, // Jan–Dez/2028
      {year:4,count:12,value:1141}, // Jan–Dez/2029
      {year:5,count:12,value:1192}, // Jan–Dez/2030
      {year:6,count:8, value:1246}  // Jan–Ago/2031
    ];
    const parcelCount=annualPlans.reduce((a,r)=>a+r.count,0); // 62
    const schedule={entryCount,parcelCount,firstDueDate,paymentDayLimit:paymentDay,lateInterestRate:0,lateInterestPeriod:'monthly',entryDeadline:'',annualPlans};
    const description=[
      'Contrato Particular de Compra e Venda de Imóvel.',
      'Vendedora: Jussara Regina Zayat (CPF 070.965.867-25).',
      'Comprador: Kayo de Souza Almeida (CPF 218.745.677-35).',
      'Imóvel: Rua Pedro Valério, Canal 520 F, Casa 06, Quadra F, Magé/RJ, CEP 25.900-415.',
      'Preço à vista: R$ 66.000,00 · Entrada/sinal: R$ 10.000,00 · Parcelas (62): R$ 69.608,00 · Total do contrato: R$ 79.608,00.',
      'Juros remuneratórios: 4,5% a.a. (0,375% a.m.). Pagamento dia 01 a 10 de cada mês · Pix chave CPF 070.965.867-25 (CEF).',
      'Mora (Cl. 10): multa 10% + juros 1% a.m. + IPCA (tratada manualmente).'
    ].join(' ');
    return {
      id:uid(),
      property:{title:'Casa Magé/RJ — Kayo de Souza Almeida', total, entryTotal, description},
      sellerPassword:'Zmart@123',buyerPassword:'Zmart@123',
      installments:makeInstallments(entryTotal,entryCount,firstDueDate,{...schedule,totalParcelValue:total-entryTotal,parcelStartOffset:0}),
      receiptInbox:[],audit:[],settings:{validationTolerance:0.01,maxFileMB:20,ocrLanguage:'por'},
      schedule,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()
    };
  }
  function seedState(){const sale=seedContractSale();return {version:STATE_VERSION,activeSaleId:sale.id,sales:[sale],updatedAt:new Date().toISOString()};}
  function normalizeState(s){
    if(Array.isArray(s?.sales)&&s.sales.length){const sales=s.sales.map(normalizeSale);const active=s.activeSaleId&&sales.some(x=>x.id===s.activeSaleId)?s.activeSaleId:sales[0].id;const out={version:STATE_VERSION,activeSaleId:active,sales,updatedAt:s.updatedAt||new Date().toISOString()};return out;}
    if(s?.property&&Array.isArray(s?.installments)){const sale=normalizeSale({id:uid(),property:s.property,installments:s.installments,receiptInbox:s.receiptInbox,audit:s.audit,settings:s.settings});const out={version:STATE_VERSION,activeSaleId:sale.id,sales:[sale],updatedAt:s.updatedAt||new Date().toISOString()};return out;}
    return seedState();
  }
  function stateHasRealPayments(st){return (st?.sales||[]).some(s=>(s.installments||[]).some(i=>i.status==='paid')) || (Array.isArray(st?.installments)&&st.installments.some(i=>i.status==='paid'));}
  function loadState(){try{const raw=JSON.parse(localStorage.getItem(DATA_KEY)||'null');
    if(!raw) return seedState();
    // Estado anterior ao cadastro do contrato: se ainda não há nenhum pagamento validado,
    // trata-se de dados de demonstração — substitui pelo cadastro real do contrato.
    if(Number(raw.version||0) < 10 && !stateHasRealPayments(raw)) return seedState();
    return normalizeState(raw);}catch{return seedState();}}
  function syncActiveSale(){const sale=state.sales?.find(x=>x.id===state.activeSaleId);if(!sale)return;sale.property=state.property;sale.installments=state.installments;sale.receiptInbox=state.receiptInbox;sale.audit=state.audit;sale.settings=state.settings;sale.schedule=state.schedule||sale.schedule;sale.sellerPassword=state.sellerPassword||sale.sellerPassword||'Zmart@123';sale.buyerPassword=state.buyerPassword||sale.buyerPassword||'Zmart@123';sale.updatedAt=new Date().toISOString();}
  function saveState(){syncActiveSale();state.updatedAt=new Date().toISOString();localStorage.setItem(DATA_KEY,JSON.stringify({version:STATE_VERSION,activeSaleId:state.activeSaleId,sales:state.sales,updatedAt:state.updatedAt}));queueCloudSync();}
  function ensureV5State(){
    if(!Array.isArray(state.sales)||!state.sales.length){const sale={id:uid(),property:state.property,installments:state.installments,receiptInbox:state.receiptInbox||[],audit:state.audit||[],settings:state.settings||{validationTolerance:0.01,maxFileMB:20,ocrLanguage:'por'},schedule:{entryCount:(state.installments||[]).filter(i=>i.type==='entrada').length,parcelCount:(state.installments||[]).filter(i=>i.type==='parcela').length,firstDueDate:(state.installments||[]).find(i=>i.dueDate)?.dueDate||today()}};state.sales=[sale];state.activeSaleId=sale.id;}
    activateSale(state.activeSaleId);
    if(!state.audit) state.audit=[]; if(!state.settings) state.settings={validationTolerance:0.01,maxFileMB:20,ocrLanguage:'por'};
    state.installments=state.installments.map(i=>({...i,receipt:i.receipt?{...i.receipt,validation:i.receipt.validation||null}:null})); saveState();
  }
  function audit(action, detail=''){state.audit=state.audit||[];state.audit.unshift({id:uid(),at:new Date().toISOString(),role,action,detail});state.audit=state.audit.slice(0,500);}
  function auditSale(sale,action,detail=''){sale.audit=Array.isArray(sale.audit)?sale.audit:[];sale.audit.unshift({id:uid(),at:new Date().toISOString(),role,action,detail});sale.audit=sale.audit.slice(0,500);}
  function formatBytes(n){if(!n)return '—';const u=['B','KB','MB','GB'];let x=n,i=0;while(x>=1024&&i<u.length-1){x/=1024;i++;}return `${x.toFixed(x>=10||i===0?0:1)} ${u[i]}`;}
  function isImageFile(f){return /^image\/(jpeg|jpg|png|webp)$/i.test(f?.type||'') || /\.(jpe?g|png|webp)$/i.test(f?.name||'');}
  function isPdfFile(f){return f?.type==='application/pdf'||/\.pdf$/i.test(f?.name||'');}

  // ===== Núcleo de pagamento parcial/acumulativo =====
  // Um lançamento (entrada ou parcela) agora guarda "received": o total já recebido para ele,
  // acumulado ao longo de vários recebimentos. O status é sempre DERIVADO do saldo:
  //   pending -> nada recebido ainda · partial -> recebeu algo mas não cobre o valor · paid -> cobre o valor.
  function installmentStatus(value,received){
    const tol=0.01, v=Number(value)||0, r=Number(received)||0;
    if(r<=tol) return 'pending';
    if(r < v-tol) return 'partial';
    return 'paid';
  }
  // Registra um recebimento (parcial ou total) sobre um lançamento, acumulando ao que já havia.
  // receiptRef (opcional) vincula ESTE pagamento específico ao seu próprio comprovante armazenado,
  // para que cada pagamento parcial mantenha seu arquivo recuperável mesmo após outros pagamentos.
  // Resolve a data de pagamento para fins de cálculo de atraso.
  // A data do comprovante é a fonte de verdade — quando disponível e anterior à data informada,
  // ela é usada para não penalizar o comprador por lançamento tardio do vendedor.
  function resolveEffectivePaymentDate(item, candidateDate){
    const receiptDate = item.receipt?.extracted?.date || '';
    if(receiptDate && candidateDate && receiptDate < candidateDate) return receiptDate;
    return candidateDate;
  }
  function applyPayment(item,amount,date,note,receiptRef=null){
    const add=Number(amount)||0;
    item.received=Number((Number(item.received||0)+add).toFixed(2));
    item.paidValue=item.received; // alias de compatibilidade com o restante da UI
    item.paidAt=date||item.paidAt||today();
    item.status=installmentStatus(item.value,item.received);
    item.history=Array.isArray(item.history)?item.history:[];
    // Usa a data efetiva (comprovante se anterior ao lançamento) para não penalizar o comprador.
    const _effectiveDate=resolveEffectivePaymentDate(item,item.paidAt||today());
    const lateDaysOnPay=lateDays({dueDate:item.dueDate},_effectiveDate);
    const lateIntOnPay=lateDaysOnPay>0?lateInterest({dueDate:item.dueDate,value:item.value},_effectiveDate):0;
    const entry={id:uid(),amount:add,date:item.paidAt,note:note||'',at:new Date().toISOString(),lateDays:lateDaysOnPay,lateInterest:lateIntOnPay};
    if(receiptRef?.blobId){entry.receiptBlobId=receiptRef.blobId;entry.receiptName=receiptRef.originalName||receiptRef.name||'comprovante';}
    item.history.push(entry);
    if(lateDaysOnPay>0){item.paidLate=true;item.lateDaysOnPayment=lateDaysOnPay;item.lateInterestCharged=lateIntOnPay;}
    return item;
  }
  // Saldo real ainda em aberto de um lançamento (nunca negativo).
  function installmentBalance(item){return Math.max(0,Number((Number(item.value||0)-Number(item.received||0)).toFixed(2)));}

  function calc(){
    const paid = state.installments.reduce((s,i)=>s+Number(i.received||0),0);
    const entryItems = state.installments.filter(i=>i.type==='entrada');
    const parcelItems = state.installments.filter(i=>i.type==='parcela');
    const entryTotal = entryItems.reduce((s,i)=>s+Number(i.value)||0,0);
    const entryPaid = entryItems.reduce((s,i)=>s+Number(i.received||0),0);
    const parcelTotal = parcelItems.reduce((s,i)=>s+Number(i.value)||0,0);
    const parcelPaid = parcelItems.reduce((s,i)=>s+Number(i.received||0),0);
    const paidItems = state.installments.filter(i=>i.status==='paid');
    const partialItems = state.installments.filter(i=>i.status==='partial');
    const pending = state.installments.filter(i=>i.status!=='paid');
    const overdue = pending.filter(i=>effectiveDueDate(i) < today()).length;
    return {paid,debt:Math.max(0,state.property.total-paid),paidPct:pct(paid,state.property.total),paidCount:paidItems.length,partialCount:partialItems.length,pendingCount:pending.length,overdue,
      entryTotal,entryPaid,entryDebt:Math.max(0,entryTotal-entryPaid),entryPct:pct(entryPaid,entryTotal),entryCount:entryItems.length,entryPaidCount:entryItems.filter(i=>i.status==='paid').length,
      parcelTotal,parcelPaid,parcelDebt:Math.max(0,parcelTotal-parcelPaid),parcelPct:pct(parcelPaid,parcelTotal),parcelCount:parcelItems.length,parcelPaidCount:parcelItems.filter(i=>i.status==='paid').length,
      totalCount:state.installments.length,validatedWithReceipt:paidItems.filter(i=>i.receipt?.validation?.status==='validated').length,documents:state.installments.filter(i=>i.receipt).length};
  }
  function showToast(msg){ const el=$('#toast'); if(!el)return; el.textContent=msg; el.classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove('show'),2400); }
  function logo(){ return `<div class="logo-icon" aria-hidden="true"><svg viewBox="0 0 64 64"><path d="M8 28 32 10l24 18v27H39V38H25v17H8Z" fill="currentColor"/><path d="M18 32h28" stroke="white" stroke-width="3" stroke-linecap="round" opacity=".85"/></svg></div>`; }

  function loginView(){return `<div class="login-page"><div class="login-orb orb-a"></div><div class="login-orb orb-b"></div><section class="login-card"><div class="login-brand">${logo()}<div><div class="brand-title">ZMART Lar<span>+</span></div><div class="brand-tag">Do compromisso à realização.</div></div></div><div class="login-title">Acesso seguro</div><div class="login-sub">Escolha seu perfil e entre para acompanhar o caminho da realização.</div><form id="loginForm"><label class="field"><span>Perfil</span><select id="loginRole"><option value="vendedor">Vendedor · ADM</option><option value="comprador">Comprador · Acompanhamento</option></select></label><label class="field"><span>Senha</span><input id="loginPass" type="password" autocomplete="current-password" required placeholder="Digite sua senha"></label><button class="primary-link submit-link" type="submit">Entrar no ZMART Lar+</button></form><div class="login-foot">${supabaseConfigured()?'Sincronizado na nuvem · vendedor e comprador compartilham os mesmos dados.':'Versão local · dados armazenados apenas neste dispositivo.'}</div></section></div>`;}

  function navItem(page,icon,label){return `<button class="nav-item ${currentPage===page?'active':''}" data-page="${page}"><span class="nav-ico">${icon}</span><span>${label}</span></button>`;}
  function appShell(){
    const seller=role==='vendedor';
    return `<aside class="sidebar" id="sidebar"><div class="brand-block">${logo()}<div><div class="brand-title">ZMART Lar<span>+</span></div><div class="brand-tag">Do compromisso à realização.</div></div></div><div class="side-section-label">NAVEGAÇÃO</div><nav>${navItem('dashboard','⌂','Resumo')}${seller?navItem('vendas','◇','Vendas'):''}${navItem('parcelas','▦','Parcelas')}${navItem('entradas','⇥','Entradas')}${navItem('pagamentos','✓','Pagamentos')}${navItem('recibos','⌁','Comprovantes')}${navItem('simulacao','◌','Simular')}${navItem('relatorios','▤','Relatórios')}${seller?navItem('backup','☁','Dados & Backup'):''}</nav><div class="sidebar-bottom"><div><div class="role-line"><span class="role-dot"></span>${seller?'Vendedor · ADM':'Comprador · somente leitura'}</div><div class="app-version">${APP_VERSION}</div></div><button class="text-link light" id="logoutBtn">Sair</button></div></aside><div class="scrim" id="scrim"></div><div class="content"><header class="topbar"><button class="menu-btn" id="menuBtn" aria-label="Abrir menu">☰</button><div class="mobile-brand"><span>ZMART Lar<span>+</span></span></div><div class="top-actions"><span class="role-badge">${seller?'ADM':'ACOMPANHAMENTO'}</span></div></header><main id="page" class="page"></main></div><div id="modalRoot"></div>`;
  }

  function render(){ $('#app').innerHTML = role ? appShell() : loginView(); bindGlobal(); if(role) renderPage(currentPage); }
  function bindGlobal(){
    $('#loginForm')?.addEventListener('submit',async e=>{e.preventDefault();const r=$('#loginRole').value,p=$('#loginPass').value;
      const btn=$('#loginForm button[type=submit]'); if(btn){btn.disabled=true;btn.textContent='Verificando…';}
      if(supabaseConfigured() && cloudBootPromise){ try{ await cloudBootPromise; }catch{} }
      if(btn){btn.disabled=false;btn.textContent='Entrar no ZMART Lar+';}
      const expected = r==='vendedor' ? (state.sellerPassword||'Zmart@123') : (state.buyerPassword||'Zmart@123');
      if(USERS[r] && p===expected){role=r;localStorage.setItem(ROLE_KEY,r);currentPage='dashboard';render();showToast('Acesso liberado.');}else showToast('Senha inválida.');});
    $('#logoutBtn')?.addEventListener('click',()=>{role=null;localStorage.removeItem(ROLE_KEY);render();});
    $('#menuBtn')?.addEventListener('click',()=>toggleSidebar(true)); $('#scrim')?.addEventListener('click',()=>toggleSidebar(false));
    $$('.nav-item').forEach(b=>b.addEventListener('click',()=>{currentPage=b.dataset.page;toggleSidebar(false);renderPage(currentPage);}));
  }
  function toggleSidebar(open){$('#sidebar')?.classList.toggle('open',open);$('#scrim')?.classList.toggle('show',open);}

  function renderPage(page){
    currentPage=page;
    const f={dashboard:dashboardPage,vendas:vendasPage,parcelas:parcelasPage,entradas:entradasPage,pagamentos:pagamentosPage,recibos:receiptsPage,simulacao:simulationPage,relatorios:reportsPage,backup:backupPage}[page]||dashboardPage;
    try{$('#page').innerHTML=f();bindPage(); if(page==='dashboard') drawDashboardCharts();}
    catch(e){console.error(e);$('#page').innerHTML=`<div class="error-box"><strong>Não foi possível carregar esta página.</strong><span>${esc(e.message)}</span><button class="text-link" id="retry">Tentar novamente</button></div>`;$('#retry')?.addEventListener('click',()=>renderPage(page));}
  }

  function pageHead(kicker,title,desc,actions=''){return `<div class="page-head"><div><div class="kicker">${kicker}</div><h1>${title}</h1><p>${desc}</p></div><div class="head-actions">${actions}</div></div>`;}
  function linkAction(id,label,extra=''){return `<button class="text-link ${extra}" id="${id}">${label}</button>`;}
  function metric(label,value,caption,accent='') {return `<article class="metric-card"><div class="metric-top"><span>${label}</span><span class="metric-accent ${accent}"></span></div><strong>${value}</strong><small>${caption}</small></article>`;}

  function yearlyParcelProgress(){
    const byYear={};
    state.installments.filter(i=>i.type==='parcela').forEach(i=>{const y=(i.dueDate||'').slice(0,4)||'—';(byYear[y]=byYear[y]||{year:y,total:0,paid:0,count:0,paidCount:0});byYear[y].total+=Number(i.value)||0;byYear[y].count++;if(i.status==='paid'){byYear[y].paid+=Number(i.paidValue||i.value)||0;byYear[y].paidCount++;}});
    return Object.values(byYear).sort((a,b)=>a.year.localeCompare(b.year)).map(y=>({...y,pct:pct(y.paid,y.total)}));
  }
  // Calcula, a partir do estado atual, qual é a "próxima parcela/entrada" e a entrada parcial em aberto.
  // Usado tanto por dashboardPage() (para exibir os cards) quanto por bindPage() (para os cliques
  // funcionarem) — assim os dois ficam sempre em sincronia, sem depender de variáveis locais
  // de uma função que não são visíveis dentro da outra.
  function dashboardNextInfo(){
    const entradaParcial=state.installments.find(i=>i.type==='entrada'&&i.status==='partial');
    // Próxima parcela pendente (ignora entrada partial com deadline no futuro)
    const parcelasPend=[...state.installments]
      .filter(i=>i.type==='parcela'&&i.status!=='paid')
      .sort((a,b)=>a.dueDate.localeCompare(b.dueDate));
    // Entrada pendente (sem nenhum pagamento ainda)
    const entradaPend=state.installments.find(i=>i.type==='entrada'&&i.status==='pending');
    // "next" = próxima parcela se existir; senão, entrada (partial ou pending)
    const next=parcelasPend[0]||entradaPend||entradaParcial||null;
    return {next,entradaParcial,parcelasPend,entradaPend};
  }
  function dashboardPage(){
    const c=calc();
    const entryDeadline=state.schedule?.entryDeadline||'';
    const {next,entradaParcial,parcelasPend}=dashboardNextInfo();
    // Para a entrada (partial/pending), ajusta o display: saldo e prazo limite
    let nextDisplay=next?{...next}:null;
    if(nextDisplay&&nextDisplay.type==='entrada'){
      nextDisplay._saldo=installmentBalance(nextDisplay);
      nextDisplay._deadline=entryDeadline||nextDisplay.dueDate;
    } else if(nextDisplay){
      nextDisplay._saldo=installmentBalance(nextDisplay);
      nextDisplay._deadline=nextDisplay.dueDate;
    }
    const overdueNow=state.installments.filter(i=>i.status!=='paid'&&effectiveDueDate(i)<today());
    const paidLateList=state.installments.filter(i=>i.paidLate);
    const alertBanner=(()=>{
      if(!overdueNow.length&&!paidLateList.length) return '';
      let html='<div class="dash-late-panel">';
      if(overdueNow.length){const worst=overdueNow.sort((a,b)=>a.dueDate.localeCompare(b.dueDate))[0];const ld=lateDays(worst);html+=`<div class="dlp-block overdue-block"><div class="dlp-icon">⚠</div><div><b>${overdueNow.length} parcela${overdueNow.length!==1?'s':''} vencida${overdueNow.length!==1?'s':''}</b><span>Mais antiga: ${esc(worst.label)} — ${ld} dia${ld!==1?'s':''} em atraso</span></div><button class="text-link danger-link" data-pfilter-go="vencidos">ver vencidas</button></div>`;}
      if(paidLateList.length){html+=`<div class="dlp-block late-paid-block"><div class="dlp-icon amber-icon">⏱</div><div><b>${paidLateList.length} pagamento${paidLateList.length!==1?'s':''} realizado${paidLateList.length!==1?'s':''} com atraso</b><span>Histórico de parcelas liquidadas após o vencimento</span></div><button class="text-link" data-pfilter-go="atrasados">ver histórico</button></div>`;}
      html+='</div>'; return html;
    })();
    return `${pageHead('VISÃO GERAL',role==='vendedor'?'Controle claro. Decisões tranquilas.':'Seu sonho está avançando.','Uma visão simples do que já aconteceu, do que falta e do próximo passo.',role==='vendedor'?`${linkAction('editProperty','editar venda')} · ${linkAction('quickAdd','+ novo lançamento','gold-link')}`:linkAction('goSim','simular cenário'))}

    <section class="stats-row">
      <article class="stat-box"><div class="stat-icon navy">🏠</div><div class="stat-body"><span>Valor do imóvel</span><strong>${money(state.property.total)}</strong></div></article>
      <article class="stat-box"><div class="stat-icon green">✓</div><div class="stat-body"><span>Total pago</span><strong class="green-val">${money(c.paid)}</strong><small>${c.paidCount} de ${c.totalCount} lançamentos${c.partialCount?` · ${c.partialCount} parcial(is)`:''}</small></div></article>
      <article class="stat-box"><div class="stat-icon gold">◔</div><div class="stat-body"><span>Saldo devedor</span><strong class="gold-val">${money(c.debt)}</strong><small>${c.paidPct.toFixed(1)}% do total já pago</small></div></article>
    </section>

    <article class="distribution-card"><div class="chart-title"><div><h3>Distribuição geral</h3><p>Pago × saldo devedor</p></div><span class="chart-badge-pct">${c.paidPct.toFixed(1)}%</span></div><div class="donut-wrap-clean"><svg id="pieChart" viewBox="0 0 220 220" role="img" aria-label="Distribuição financeira"></svg><div class="legend"><span><i class="dot gold-dot"></i>Entrada paga <b>${money(c.entryPaid)}</b></span><span><i class="dot green-dot"></i>Parcelas pagas <b>${money(c.parcelPaid)}</b></span><span><i class="dot navy-dot"></i>Saldo restante <b>${money(c.debt)}</b></span></div></div></article>
    ${alertBanner}

    <section class="section-head"><div><h2>Duas jornadas</h2><p>A entrada e as prestações têm tratativas e prazos diferentes.</p></div></section>
    <div class="two-journeys">${dashboardEntryTimeline(c)}${dashboardYearlyProgress()}</div>

    <section class="section-head"><div><h2>Evolução no tempo</h2><p>Acumulado mês a mês · entrada, parcelas e saldo devedor.</p></div></section>
    <article class="chart-card wide-chart"><div class="chart-legend-inline"><span><i class="dot gold-dot"></i>Entrada</span><span><i class="dot green-dot"></i>Parcelas</span><span><i class="dot navy-dot-light"></i>Saldo devedor</span></div><svg id="lineChart" class="line-chart-tall" viewBox="0 0 800 300" preserveAspectRatio="none" role="img" aria-label="Evolução dos pagamentos por período"></svg></article>

    ${entradaParcial&&parcelasPend.length?`<section class="section-head"><div><h2>Entrada em andamento</h2><p>Saldo a quitar até o prazo limite.</p></div>${linkAction('goEntradas','ver entrada')}</section><article class="next-card" style="border-left:3px solid var(--gold)"><div><span>${esc(entradaParcial.label)}</span><strong>${money(installmentBalance(entradaParcial))}</strong><small>Saldo · prazo limite ${dateBR(entryDeadline||entradaParcial.dueDate)}</small></div><div class="next-actions">${role==='vendedor'?linkAction('validateEntrada','registrar pagamento','green-link'):''}${linkAction('entradaReceipt','comprovante')}</div></article>`:''}
    <section class="section-head"><div><h2>Próximo passo</h2><p>${nextDisplay?'O próximo compromisso financeiro.':'Você está em dia.'}</p></div>${nextDisplay?linkAction('openNext',nextDisplay.type==='parcela'?'ver parcela':'ver entrada'):''}</section>${nextDisplay?`<article class="next-card"><div><span>${esc(nextDisplay.label)}</span><strong>${money(nextDisplay._saldo>0?nextDisplay._saldo:nextDisplay.value)}</strong><small>${nextDisplay.type==='entrada'?(nextDisplay._saldo>0?`Saldo · prazo limite ${dateBR(nextDisplay._deadline)}`:`Prazo limite ${dateBR(nextDisplay._deadline)} · Pendente`):`Vencimento ${dateBR(nextDisplay.dueDate)} · ${nextDisplay.status==='partial'?'Parcial':'Pendente'}`}</small></div><div class="next-actions">${role==='vendedor'&&nextDisplay.status!=='paid'?linkAction('validateNext','validar','green-link'):''}${linkAction('nextReceipt','comprovante')}</div></article>`:`<div class="empty-card">Tudo certo por aqui. Continue acompanhando sua evolução.</div>`}`;
  }

  function dashboardEntryTimeline(c){
    const entries=state.installments.filter(i=>i.type==='entrada').sort((a,b)=>a.dueDate.localeCompare(b.dueDate));
    if(!entries.length) return '';
    const deadline=state.schedule?.entryDeadline;
    const steps=entries.map(e=>{
      const isPaid=e.status==='paid';
      const isPartial=e.status==='partial';
      const stepClass=isPaid?'done':isPartial?'partial':'todo';
      let valueInfo='';
      if(isPaid){
        valueInfo=`${money(e.paidValue||e.value)} · pago em ${dateBR(e.paidAt)}`;
      } else if(isPartial){
        const balance=Math.max(0,Number(e.value)-Number(e.received||0));
        valueInfo=`${money(e.received)} pago de ${money(e.value)} · falta ${money(balance)}`;
      } else {
        valueInfo=`Previsto: ${money(e.value)} · venc. ${dateBR(e.dueDate)} · pendente`;
      }
      return `<li class="tl-step ${stepClass}"><span class="tl-dot"></span><div class="tl-body"><b>${esc(e.label)}</b><small>${valueInfo}</small></div></li>`;
    }).join('');
    return `<article class="timeline-card gold-accent"><div class="timeline-head"><div><span class="mini-tag">ENTRADA</span><h3>Quitação da entrada</h3><p>${c.entryPaidCount} de ${c.entryCount} parcelas · ${c.entryPct.toFixed(1)}% pago</p></div><div class="timeline-figures"><div><small>Pago</small><b>${money(c.entryPaid)}</b></div><div><small>Falta</small><b>${money(c.entryDebt)}</b></div>${deadline?`<div><small>Limite</small><b>${dateBR(deadline)}</b></div>`:''}</div></div><div class="progress-track"><i style="width:${Math.min(100,c.entryPct)}%"></i></div><ul class="timeline-list">${steps}</ul></article>`;
  }
  function dashboardYearlyProgress(){
    const years=yearlyParcelProgress();
    if(!years.length) return '';
    const c=calc();
    const rows=years.map(y=>`<div class="year-row"><div class="year-label"><b>${y.year}</b><small>${y.paidCount}/${y.count} parcelas</small></div><div class="year-bar"><div class="progress-track"><i style="width:${Math.min(100,y.pct)}%"></i></div></div><div class="year-figures"><b>${y.pct.toFixed(0)}%</b><small>${money(y.paid)} / ${money(y.total)}</small></div></div>`).join('');
    return `<article class="timeline-card navy-accent"><div class="timeline-head"><div><span class="mini-tag">PRESTAÇÕES</span><h3>Progresso por ano</h3><p>${c.parcelPaidCount} de ${c.parcelCount} prestações · ${c.parcelPct.toFixed(1)}% do saldo pago</p></div><div class="timeline-figures"><div><small>Pago</small><b>${money(c.parcelPaid)}</b></div><div><small>Falta</small><b>${money(c.parcelDebt)}</b></div></div></div><div class="year-progress">${rows}</div></article>`;
  }
  function kanbanColumn(title,desc,items,kind){return `<section class="kanban-col ${kind}"><div class="kanban-head"><div><h3>${title}</h3><p>${desc}</p></div><span>${items.length}</span></div><div class="kanban-list">${items.length?items.map(installmentCard).join(''):`<div class="kanban-empty">Nenhum item nesta coluna.</div>`}</div></section>`;}
  function statusLabel(st){return st==='paid'?'Pago':st==='partial'?'Parcial':'Pendente';}
  function installmentCard(i){
    const seller=role==='vendedor';
    return `<article class="kanban-card"><div class="card-row"><div><span class="mini-tag">${i.type==='entrada'?'ENTRADA':'PARCELA'}</span><h4>${esc(i.label)}</h4><small>Venc. ${dateBR(i.dueDate)}</small></div><span class="status ${i.status}">${statusLabel(i.status)}</span></div><div class="card-money">${i.status==='partial'?`${money(i.received)} <small>de ${money(i.value)}</small>`:money(i.status==='paid'?i.paidValue:i.value)}</div>${i.status==='paid'?`<small class="received">Recebido ${dateBR(i.paidAt)}</small>`:''}${i.status==='partial'?`<small class="received">Falta ${money(installmentBalance(i))} · último recebimento ${dateBR(i.paidAt)}</small>`:''}<div class="card-links">${seller&&i.status!=='paid'?`<button class="text-link green-link" data-pay="${i.id}">${i.status==='partial'?'completar':'validar'}</button>`:''}${seller&&i.type!=='entrada'?`<button class="text-link" data-edit="${i.id}">editar</button><button class="text-link danger-link" data-delete="${i.id}">excluir</button>`:''}<button class="text-link" data-receipt="${i.id}">comprovante</button></div></article>`;
  }
  function vendasPage(){
    const seller=role==='vendedor';
    return `${pageHead('GESTÃO COMERCIAL','Vendas','Gerencie várias vendas simultaneamente sem misturar parcelas, entradas ou comprovantes.',seller?linkAction('newSale','+ nova venda','gold-link'):'')}<div class="sales-grid">${state.sales.map(s=>{const active=s.id===state.activeSaleId;const paid=s.installments.filter(i=>i.status==='paid').reduce((a,i)=>a+Number(i.paidValue||i.value),0);const pending=s.installments.filter(i=>i.status!=='paid').length;return `<article class="sale-card ${active?'active':''}"><div class="sale-card-top"><span class="mini-tag">${active?'VENDA ATIVA':'VENDA'}</span><span class="status ${active?'paid':'pending'}">${active?'em uso':'disponível'}</span></div><h3>${esc(s.property.title)}</h3><p>${esc(s.property.description||'Sem descrição')}</p><div class="sale-values"><div><small>Valor</small><strong>${money(s.property.total)}</strong></div><div><small>Pago</small><strong>${money(paid)}</strong></div><div><small>Pendente</small><strong>${pending}</strong></div></div><div class="sale-rule-line">${Number(s.schedule?.entryCount||0)} entrada(s) · ${Number(s.schedule?.parcelCount||0)} parcela(s) · dia ${Number(s.schedule?.paymentDayLimit||1)} · juros ${Number(s.schedule?.lateInterestRate||0).toLocaleString('pt-BR')}% ${s.schedule?.lateInterestPeriod==='daily'?'dia':'mês'}</div><div class="card-links">${active?'':`<button class="text-link green-link" data-activate-sale="${s.id}">abrir venda</button>`}<button class="text-link" data-edit-sale="${s.id}">editar</button>${seller&&state.sales.length>1?`<button class="text-link danger-link" data-delete-sale="${s.id}">excluir</button>`:''}</div></article>`;}).join('')}</div><div class="sales-note"><b>Isolamento financeiro:</b> cada venda possui seu próprio valor do imóvel, entrada, parcelas, pagamentos, comprovantes, auditoria e relatórios.</div>`;
  }

  function parcelasPage(){
    const parcels=state.installments.filter(i=>i.type==='parcela').sort((a,b)=>a.dueDate.localeCompare(b.dueDate)); const pending=parcels.filter(i=>i.status!=='paid'); const paid=parcels.filter(i=>i.status==='paid'); const show=x=>installmentFilter==='pendentes'?x.filter(i=>i.status!=='paid'):installmentFilter==='pagas'?x.filter(i=>i.status==='paid'):x;
    return `${pageHead('PLANEJAMENTO','Parcelas','Somente parcelas do financiamento. Entradas ficam em uma página própria.',role==='vendedor'?linkAction('newParcel','+ nova parcela','gold-link'):linkAction('goPayments','ver pagamentos'))}<div class="page-summary"><div><span>Total de parcelas</span><strong>${parcels.length}</strong></div><div><span>Pagas</span><strong>${paid.length}</strong></div><div><span>Em aberto</span><strong>${pending.length}</strong></div><div><span>Próximo vencimento</span><strong>${pending[0]?dateBR(pending[0].dueDate):'—'}</strong></div></div><div class="filter-row"><button class="text-filter ${installmentFilter==='todos'?'active':''}" data-ifilter="todos">todas</button><button class="text-filter ${installmentFilter==='pendentes'?'active':''}" data-ifilter="pendentes">pendentes</button><button class="text-filter ${installmentFilter==='pagas'?'active':''}" data-ifilter="pagas">pagas</button></div><div class="kanban"><div class="kanban-rail two-columns">${kanbanColumn('A pagar','Parcelas abertas',show(pending),'pending')}${kanbanColumn('Pagas','Parcelas validadas',show(paid),'paid')}</div></div>`;
  }
  function entradasPage(){
    const c=calc();
    const entrada=state.installments.find(i=>i.type==='entrada');
    const seller=role==='vendedor';
    if(!entrada){
      return `${pageHead('PLANEJAMENTO','Entrada','Esta venda não possui valor de entrada cadastrado.',seller?linkAction('editProperty','editar venda','gold-link'):linkAction('goPayments','ver pagamentos'))}<div class="empty-card">Nenhuma entrada cadastrada. Defina o valor da entrada em "editar venda" para habilitar este bloco.</div>`;
    }
    const deadline=state.schedule?.entryDeadline;
    const balance=installmentBalance(entrada);
    const isPaid=entrada.status==='paid';
    const topAction=seller?(isPaid?'':linkAction('newEntryPayment','+ gerar novo pagamento','gold-link')):linkAction('goPayments','ver pagamentos');
    const progresso=`<div class="entry-progress-card"><div class="entry-progress-head"><div><span>Quitação da entrada</span><strong>${c.entryPct.toFixed(1)}% concluída</strong></div><div class="entry-progress-figures"><span>Pago <b>${money(c.entryPaid)}</b></span><span>Falta <b>${money(c.entryDebt)}</b></span></div></div><div class="progress-track"><i style="width:${Math.min(100,c.entryPct)}%"></i></div><div class="entry-progress-foot"><span>Total da entrada (cadastrado na venda): <b>${money(entrada.value)}</b></span>${deadline?`<span>Limite de quitação: <b>${dateBR(deadline)}</b></span>`:'<span>Sem data limite definida</span>'}${isPaid?'<span class="entry-done-tag">✓ Entrada quitada</span>':''}</div></div>`;
    // Cada pagamento parcial vira o seu PRÓPRIO card, numerado na ordem em que foi lançado —
    // nunca uma "nova parcela": todos abatem o mesmo valor total (entrada.value) cadastrado na venda.
    const history=(entrada.history||[]);
    const paymentCards=history.map((h,idx)=>{
      const n=String(idx+1).padStart(2,'0');
      const runningTotal=history.slice(0,idx+1).reduce((a,x)=>a+Number(x.amount||0),0);
      return `<article class="kanban-card entry-payment-card"><div class="card-row"><div><span class="mini-tag">PAGAMENTO ${n}</span><h4>${money(h.amount)}</h4><small>Recebido em ${dateBR(h.date)}</small></div><span class="status paid">Confirmado</span></div>${h.note?`<small class="received">${esc(h.note)}</small>`:''}${h.lateDays>0?`<small class="late-note">${h.lateDays}d de atraso</small>`:''}<div class="entry-payment-progress"><div class="progress-track"><i style="width:${Math.min(100,pct(runningTotal,entrada.value))}%"></i></div><small>${money(runningTotal)} de ${money(entrada.value)} acumulado até este pagamento</small></div>${h.receiptBlobId?`<div class="card-links"><button class="text-link" data-history-receipt="${h.receiptBlobId}" data-history-name="${esc(h.receiptName||'comprovante')}">comprovante</button></div>`:''}</article>`;
    }).join('');
    return `${pageHead('PLANEJAMENTO','Entrada','Valor único, definido no cadastro da venda. Cada pagamento fica registrado em seu próprio card até a quitação total — sem abrir novas parcelas.',topAction)}
    <div class="page-summary"><div><span>Total da entrada</span><strong>${money(entrada.value)}</strong></div><div><span>Pago</span><strong>${money(entrada.received)}</strong></div><div><span>Falta pagar</span><strong>${money(balance)}</strong></div><div><span>Situação</span><strong>${statusLabel(entrada.status)}</strong></div></div>
    ${progresso}
    <section class="section-head"><div><h2>Pagamentos da entrada</h2><p>${history.length?`${history.length} pagamento(s) registrado(s), em ordem cronológica.`:'Nenhum pagamento registrado ainda.'}</p></div></section>
    <div class="entry-payments-grid">${paymentCards||'<div class="kanban-empty">Nenhum pagamento registrado ainda. Use "gerar novo pagamento" para lançar o primeiro comprovante.</div>'}</div>`;
  }
  function pagamentosPage(){
    const paid=state.installments.filter(i=>i.status==='paid').sort((a,b)=>(b.paidAt||'').localeCompare(a.paidAt||'')); const pending=state.installments.filter(i=>i.status!=='paid').sort((a,b)=>a.dueDate.localeCompare(b.dueDate)); const overdue=pending.filter(i=>effectiveDueDate(i)<today()); const show=x=>paymentFilter==='recebidos'?x.filter(i=>i.status==='paid'):paymentFilter==='pendentes'?x.filter(i=>i.status!=='paid'):paymentFilter==='vencidos'?x.filter(i=>i.status!=='paid'&&effectiveDueDate(i)<today()):x; const paidLateItems=paid.filter(i=>i.paidLate);
    const overdueItems=overdue;
    const showPaidLate=paymentFilter==='atrasados';
    return `${pageHead('MOVIMENTAÇÃO', 'Pagamentos', 'Histórico completo de recebimentos, pendências e atrasos.',role==='vendedor'?linkAction('newPayment','+ registrar pagamento','green-link'):linkAction('paymentReport','imprimir pagamentos'))}
    <div class="page-summary">
      <div><span>Recebidos</span><strong>${paid.length}</strong></div>
      <div><span>Total recebido</span><strong>${money(paid.reduce((s,i)=>s+Number(i.paidValue||i.value),0))}</strong></div>
      <div><span>Pendentes</span><strong>${pending.length}</strong></div>
      <div><span class="${overdue.length?'rose-label':''}">Vencidos</span><strong class="${overdue.length?'rose-val':''}">${overdue.length}</strong></div>
      <div><span class="${paidLateItems.length?'amber-label':''}">Pagos com atraso</span><strong class="${paidLateItems.length?'amber-val':''}">${paidLateItems.length}</strong></div>
    </div>
    ${overdue.length?`<div class="overdue-alert"><span class="overdue-alert-icon">⚠</span><div><b>${overdue.length} parcela${overdue.length!==1?'s':''} vencida${overdue.length!==1?'s':''}</b><span>${overdue.map(i=>esc(i.label)+' · '+overdueLabel(i)).join(' · ')}</span></div></div>`:''}
    <div class="filter-row">
      <button class="text-filter ${paymentFilter==='todos'?'active':''}" data-pfilter="todos">todos</button>
      <button class="text-filter ${paymentFilter==='recebidos'?'active':''}" data-pfilter="recebidos">recebidos</button>
      <button class="text-filter ${paymentFilter==='pendentes'?'active':''}" data-pfilter="pendentes">pendentes</button>
      <button class="text-filter ${paymentFilter==='vencidos'?'active':''}" data-pfilter="vencidos">vencidos</button>
      <button class="text-filter ${paymentFilter==='atrasados'?'active':''}" data-pfilter="atrasados">pagos com atraso${paidLateItems.length?' ('+paidLateItems.length+')':''}</button>
    </div>
    ${showPaidLate
      ? `<section class="late-history-section"><div class="late-history-head"><h3>Histórico de pagamentos realizados com atraso</h3><p>Parcelas e entradas que foram liquidadas após a data de vencimento.</p></div><div class="late-history-list">${paidLateItems.length?paidLateItems.map(i=>`<div class="late-history-card"><div class="lhc-left"><span class="mini-tag">${i.type==='entrada'?'ENTRADA':'PARCELA'}</span><h4>${esc(i.label)}</h4><div class="lhc-dates"><span>Venceu em <b>${dateBR(i.dueDate)}</b></span><span>Pago em <b>${dateBR(i.paidAt)}</b></span><span class="late-gap"><b>${i.lateDaysOnPayment} dia${i.lateDaysOnPayment!==1?'s':''} de atraso</b></span></div></div><div class="lhc-right"><div><small>Valor original</small><b>${money(i.value)}</b></div>${i.lateInterestCharged?`<div><small>Juros de atraso</small><b class="rose-val">${money(i.lateInterestCharged)}</b></div>`:''}<div><small>Valor pago</small><b>${money(i.paidValue||i.value)}</b></div></div></div>`).join(''):`<div class="kanban-empty">Nenhum pagamento realizado com atraso.</div>`}</div></section>`
      : `<div class="payment-board">
          <section class="payment-column received">
            <div class="payment-head"><h3>Recebidos</h3><span>Histórico de pagamentos validados</span></div>
            <div class="payment-list">${show(paid).length?show(paid).map(paymentCard).join(''):`<div class="kanban-empty">Nenhum pagamento recebido.</div>`}</div>
          </section>
          <section class="payment-column pending">
            <div class="payment-head"><h3>Aguardando validação</h3><span>Valores ainda não confirmados</span></div>
            <div class="payment-list">${show(pending).length?show(pending).map(paymentCard).join(''):`<div class="kanban-empty">Nenhum pagamento pendente.</div>`}</div>
          </section>
        </div>`
    }`;}
  // Retorna a data de vencimento efetiva de um lançamento.
  // Para entradas: usa entryDeadline (prazo final para quitar) quando configurado,
  // pois o comprador pode pagar parcialmente até essa data sem incorrer em atraso.
  // Para parcelas: usa dueDate normalmente.
  function effectiveDueDate(i){
    if(i?.type==='entrada'){
      const dl=state.schedule?.entryDeadline||'';
      if(dl) return dl;
    }
    return i?.dueDate||'';
  }
  function lateDays(i,asOf=null){
    const due=effectiveDueDate(i)||i?.dueDate;
    if(!due)return 0;
    const end=new Date((asOf||today())+'T00:00:00');
    const start=new Date(due+'T00:00:00');
    return Math.max(0,Math.floor((end-start)/86400000));
  }
  function lateInterest(i,asOf=null){const rate=Math.max(0,Number(state.schedule?.lateInterestRate||0));if(!rate)return 0;const days=lateDays(i,asOf);if(!days)return 0;const base=Number(i.value)||0;return base*(rate/100)*(state.schedule?.lateInterestPeriod==='daily'?days:days/30);}
  function isOverdue(i){return i.status!=='paid'&&effectiveDueDate(i)<today();}
  function overdueLabel(i){const d=lateDays(i);if(d<=0)return '';if(d===1)return '1 dia em atraso';return d+' dias em atraso';}
  function paymentCard(i){
    const seller=role==='vendedor';
    const overdue=isOverdue(i);
    const daysLate=overdue?lateDays(i):0;
    const lateEst=overdue?lateInterest(i):0;
    const paidLate=i.status==='paid'&&i.paidLate;
    const typetag=i.type==='entrada'?'ENTRADA':'PARCELA';
    let statusLine='';
    if(i.status==='paid') statusLine=`Recebido em ${dateBR(i.paidAt)}${paidLate?` · <b class="late-paid-note">${i.lateDaysOnPayment} dia(s) de atraso</b>`:''}`;
    else if(i.status==='partial') statusLine=`Parcial · pago ${money(i.received)} de ${money(i.value)} · falta ${money(installmentBalance(i))}`;
    else statusLine=`Vencimento ${dateBR(i.dueDate)}`;
    return `<article class="payment-card ${overdue?'overdue-card':''} ${paidLate?'paid-late-card':''}">
      <div class="payment-main">
        <div>
          <div class="card-tags-row">
            <span class="mini-tag">${typetag}</span>
            ${overdue?`<span class="badge-overdue">${daysLate} dia${daysLate!==1?'s':''} em atraso</span>`:''}
            ${paidLate?`<span class="badge-paid-late">Pago com ${i.lateDaysOnPayment}d de atraso</span>`:''}
          </div>
          <h4>${esc(i.label)}</h4>
          <small>${statusLine}</small>
          ${overdue&&lateEst?`<small class="late-note">Juros estimados: ${money(lateEst)} · Total c/ juros: ${money(Number(i.value)+lateEst)}</small>`:''}
          ${paidLate&&i.lateInterestCharged?`<small class="late-note">Juros de atraso registrados: ${money(i.lateInterestCharged)}</small>`:''}
        </div>
        <strong>${money(i.status==='paid'?i.paidValue:i.value)}</strong>
      </div>
      <div class="card-links">
        ${seller&&i.status!=='paid'?`<button class="text-link green-link" data-pay="${i.id}">${i.status==='partial'?'completar recebimento':'validar recebimento'}</button>`:''}
        ${seller&&i.status==='paid'?`<button class="text-link" data-pay="${i.id}">editar pagamento</button>`:''}
        <button class="text-link" data-receipt="${i.id}">comprovante</button>
        ${seller?`<button class="text-link" data-edit="${i.id}">editar</button>`:''}
      </div>
    </article>`;}

  function receiptsPage(){
    const receipts=[];
    state.installments.forEach(i=>{ if(i.receipt) receipts.push({i,r:i.receipt}); });
    receipts.sort((a,b)=>(b.r.importedAt||b.r.createdAt||'').localeCompare(a.r.importedAt||a.r.createdAt||''));
    return `${pageHead('DOCUMENTOS','Comprovantes','Leia PDF ou imagem, confira os dados extraídos e transforme o documento em um pagamento validado.',role==='vendedor'?linkAction('importReceipt','importar comprovante','gold-link'): '')}
      <section class="receipt-import-hero"><div><span class="hero-chip">FLUXO AUTOMÁTICO</span><h2>PDF → dados → pagamento → recibo do sistema → Google Drive</h2><p>O PDF original permanece preservado. Os dados extraídos ficam vinculados ao lançamento e podem ser revisados antes da confirmação.</p></div><div class="receipt-flow"><span>01 · Ler PDF</span><span>02 · Conferir</span><span>03 · Registrar</span><span>04 · Arquivar</span></div></section>
      <div class="page-summary"><div><span>Recibos vinculados</span><strong>${receipts.length}</strong></div><div><span>Pagamentos originados</span><strong>${receipts.filter(x=>x.r.source==='pdf-import').length}</strong></div><div><span>Drive</span><strong>${receipts.filter(x=>x.r.driveFileId).length}</strong></div><div><span>Pendentes</span><strong>${receipts.filter(x=>!x.r.driveFileId).length}</strong></div></div>
      ${state.receiptInbox?.length?`<section class="inbox-card"><div><b>Documentos sem conciliação</b><span>${state.receiptInbox.length} comprovante(s) aguardando vínculo com uma parcela/entrada.</span></div><button class="text-link green-link" id="openInbox">resolver pendências</button></section>`:''}<section class="receipt-list">${receipts.length?receipts.map(({i,r})=>`<article class="receipt-record"><div><span class="mini-tag">${esc(r.source==='pdf-import'?'PDF IMPORTADO':'COMPROVANTE')}</span><h3>${esc(i.label)}</h3><p>${esc(r.originalName||r.name||'Documento')} · ${r.extracted?.amount?money(r.extracted.amount):money(i.paidValue||i.value)} · ${r.extracted?.date?dateBR(r.extracted.date):dateBR(i.paidAt||i.dueDate)}</p></div><div class="receipt-record-actions"><span class="drive-state ${r.driveFileId?'ok':''}">${r.driveFileId?'Google Drive sincronizado':'Somente neste dispositivo'}</span><button class="text-link" data-receipt="${i.id}">abrir</button>${role==='vendedor'&&!r.driveFileId?`<button class="text-link green-link" data-drive-receipt="${i.id}">enviar ao Drive</button>`:''}</div></article>`).join(''):`<div class="empty-card">Nenhum recibo importado ainda. Use <b>importar comprovante</b> para começar.</div>`}</section>`;
  }

  function simulationPage(){const c=calc(); return `${pageHead('PLANEJAMENTO','Simular','Teste cenários sem alterar nenhum dado real.',linkAction('simReset','resetar'))}<section class="sim-layout"><article class="sim-card"><div class="field"><span>Valor por pagamento</span><input id="simValue" type="text" data-money inputmode="decimal" value="5.000,00" placeholder="0,00"></div><div class="field"><span>Quantidade</span><input id="simCount" type="number" min="1" step="1" value="12"></div><div class="field"><span>Valor extra</span><input id="simExtra" type="text" data-money inputmode="decimal" value="0,00" placeholder="0,00"></div></article><article class="sim-result"><span>Saldo atual</span><strong>${money(c.debt)}</strong><div class="sim-result-grid" id="simResult"><div><small>Total simulado</small><b>${money(60000)}</b></div><div><small>Saldo no cenário</small><b>${money(Math.max(0,c.debt-60000))}</b></div><div><small>Progresso</small><b>${pct(c.paid+60000,state.property.total).toFixed(1)}%</b></div></div><p>Esta simulação é apenas informativa. Nenhum lançamento real será alterado.</p></article></section>`;}

  function reportsPage(){return `${pageHead('DOCUMENTOS','Relatórios','Gere um PDF claro para acompanhar ou compartilhar a situação.',linkAction('reportFull','relatório completo','gold-link'))}<div class="report-grid"><article class="report-card"><span class="report-icon">✓</span><h3>Extrato de pagamentos</h3><p>Lista tudo o que já foi validado.</p><button class="text-link" id="reportPaid">gerar PDF</button></article><article class="report-card"><span class="report-icon">◷</span><h3>Agenda financeira</h3><p>Parcelas ainda abertas e seus vencimentos.</p><button class="text-link" id="reportSchedule">gerar PDF</button></article><article class="report-card"><span class="report-icon">▤</span><h3>Relatório completo</h3><p>Visão geral, parcelas, pagamentos e saldo.</p><button class="text-link" id="reportFull2">gerar PDF</button></article><article class="report-card"><span class="report-icon">▨</span><h3>Resumo para o comprador</h3><p>Relatório sem controles administrativos.</p><button class="text-link" id="reportBuyer">gerar PDF</button></article><article class="report-card"><span class="report-icon">⌁</span><h3>Dossiê de comprovantes</h3><p>Relação dos documentos originais, validações e transações.</p><button class="text-link" id="reportReceipts">gerar PDF</button></article></div>`;}
  function backupPage(){return `${pageHead('DADOS','Dados & Backup','Proteja seus dados, documentos e integração com o Google Drive.',linkAction('backupExport','exportar backup','gold-link'))}<div class="backup-grid"><article class="backup-card version-card"><h3>📌 Versão instalada</h3><p><b>${APP_VERSION}</b> · ${esc(APP_BUILD)}</p><p class="helper">Se você acabou de publicar uma atualização e esta versão não mudou depois de recarregar a página, o navegador ainda está usando o cache antigo do app — force um recarregamento completo (Ctrl+Shift+R) ou desregistre o Service Worker em Ferramentas do desenvolvedor → Application.</p></article>${role==='vendedor'?`<article class="backup-card"><h3>Senhas de acesso</h3><p>Defina senhas diferentes para o vendedor e para o comprador. Depois de salvar, avise o comprador da nova senha dele${supabaseConfigured()?' — a alteração é sincronizada na nuvem.':'.'}</p><form id="passwordForm"><label class="field"><span>Senha do vendedor</span><input id="pwSeller" type="text" value="${esc(state.sellerPassword||'Zmart@123')}" required></label><label class="field"><span>Senha do comprador</span><input id="pwBuyer" type="text" value="${esc(state.buyerPassword||'Zmart@123')}" required></label><div class="form-actions"><button class="primary-link" type="submit">salvar senhas</button></div></form></article>`:''}<article class="backup-card"><h3>Sincronização em nuvem</h3><p>${supabaseConfigured()?'Conectado ao Supabase. Vendedor e comprador compartilham os mesmos dados — a página busca o mais recente sempre que é aberta ou recarregada.':'Não configurada. Os dados ficam somente neste dispositivo/navegador. Preencha supabaseUrl e supabaseAnonKey em config.js para compartilhar entre vendedor e comprador.'}</p><button class="text-link ${supabaseConfigured()?'green-link':''}" id="manualSync">${supabaseConfigured()?'sincronizar agora':'nuvem não configurada'}</button></article><article class="backup-card"><h3>Backup local</h3><p>Gera um arquivo JSON com todas as vendas, parcelas, pagamentos e metadados. Os documentos binários vinculados também são incluídos no backup.</p><button class="text-link" id="backupExport2">baixar backup</button></article><article class="backup-card"><h3>Restaurar backup</h3><p>Substitui os dados atuais por um backup válido.</p><label class="text-link file-link">selecionar arquivo<input id="backupFile" type="file" accept="application/json,.json"></label></article><article class="backup-card"><h3>Cadastro do contrato</h3><p>Recria a venda exatamente conforme o contrato (Casa Magé/RJ · imóvel R$ 79.608 · entrada R$ 10.000 · 62 parcelas). <b>Atenção:</b> substitui a venda atual e os pagamentos já lançados.</p><button class="text-link danger-link" id="reloadContract">recarregar cadastro do contrato</button></article><article class="backup-card"><h3>Integridade local</h3><p>${calc().documents} comprovantes vinculados · ${calc().validatedWithReceipt} pagamentos validados com documento. O original e os recibos gerados ficam no IndexedDB deste navegador${supabaseConfigured()?' e também no Supabase Storage (nuvem)':''}.</p></article><article class="backup-card"><h3>Google Drive</h3><p>Conecte uma conta Google para enviar automaticamente o PDF original e o recibo gerado pelo ZMART.</p><label class="field"><span>Google Client ID</span><input id="googleClientId" value="${esc(localStorage.getItem('zmart_google_client_id')||ZMART_CONFIG.googleClientId||'')}" placeholder="xxxx.apps.googleusercontent.com"></label><div class="form-actions"><button class="text-link" id="saveGoogleClient">salvar ID</button><button class="text-link green-link" id="connectDrive">conectar Google Drive</button></div><small class="helper">O Client ID não é segredo. Para OAuth funcionar em produção, o domínio da aplicação precisa estar autorizado no Google Cloud.</small><div id="driveStatus" class="parse-status">${localStorage.getItem('zmart_drive_connected')==='1'?'Conta Google conectada nesta sessão.':'Google Drive não conectado.'}</div></article><article class="backup-card"><h3>Google Agenda</h3><p>Crie rapidamente um evento para o próximo vencimento.</p><button class="text-link" id="openCalendar">adicionar próximo vencimento</button></article>${role==='vendedor'?`<article class="backup-card gh-deploy-card"><h3>🚀 Publicar atualização (GitHub Pages)</h3><p>Envie um arquivo atualizado (<b>app.js</b>, <b>styles.css</b> etc.) diretamente para o repositório. O GitHub Pages publica o novo código em segundos, sem precisar abrir o site do GitHub.</p><label class="field"><span>Token do GitHub (ghp_…)</span><input id="ghToken" type="password" value="${esc(localStorage.getItem('zmart_gh_token')||'')}" placeholder="ghp_xxxxxxxxxxxx" autocomplete="off"></label><label class="field"><span>Repositório (usuario/repo)</span><input id="ghRepo" value="${esc(localStorage.getItem('zmart_gh_repo')||'')}" placeholder="seu-usuario/zmart-lar-plus"></label><label class="field"><span>Branch</span><input id="ghBranch" value="${esc(localStorage.getItem('zmart_gh_branch')||'main')}" placeholder="main"></label><div class="form-actions"><button class="text-link" id="ghSaveConfig">salvar configuração</button></div><div style="border-top:1px solid var(--border);margin:14px 0"></div><label class="field"><span>Arquivo para publicar</span><input id="ghFile" type="file"><small class="helper">Selecione o arquivo (ex: app.js) que substituirá o arquivo de mesmo nome no repositório.</small></label><div class="form-actions"><button class="primary-link green-button" id="ghDeploy">publicar no GitHub Pages</button></div><div id="ghStatus" class="parse-status" style="margin-top:8px"></div><small class="helper">O token precisa da permissão <b>Contents: Write</b> (escopo <b>repo</b>). Ele fica salvo somente neste navegador, nunca vai para a nuvem.</small></article>`:''}`;}


  function bindPage(){
    // Recalcula "próxima parcela/entrada" aqui dentro: dashboardPage() tem sua própria cópia local
    // dessas variáveis, que não é visível aqui. Sem isto, os botões "validar", "comprovante" e
    // "registrar pagamento" do dashboard clicavam sem fazer nada (ReferenceError silencioso).
    const {next,entradaParcial}=dashboardNextInfo();
    $('#importReceipt')?.addEventListener('click',()=>importReceiptModal()); $('#newSale')?.addEventListener('click',()=>saleModal()); $$('#page [data-activate-sale]').forEach(b=>b.addEventListener('click',()=>switchSale(b.dataset.activateSale))); $$('#page [data-edit-sale]').forEach(b=>b.addEventListener('click',()=>saleModal(b.dataset.editSale))); $$('#page [data-delete-sale]').forEach(b=>b.addEventListener('click',()=>deleteSale(b.dataset.deleteSale))); $('#openInbox')?.addEventListener('click',openReceiptInbox); $$('#page [data-drive-receipt]').forEach(b=>b.addEventListener('click',()=>uploadReceiptToDrive(b.dataset.driveReceipt))); $('#quickAdd')?.addEventListener('click',()=>installmentModal()); $('#editProperty')?.addEventListener('click',()=>saleModal(state.activeSaleId)); $('#newParcel')?.addEventListener('click',()=>installmentModal('parcela')); $('#newPayment')?.addEventListener('click',()=>{const n=state.installments.find(i=>i.status!=='paid'); n?paymentModal(n.id):showToast('Não há lançamentos pendentes.');}); $('#goSim')?.addEventListener('click',()=>{currentPage='simulacao';renderPage(currentPage);}); $('#goPayments')?.addEventListener('click',()=>{currentPage='pagamentos';renderPage(currentPage);});
    $$('#page [data-ifilter]').forEach(b=>b.addEventListener('click',()=>{installmentFilter=b.dataset.ifilter;renderPage(currentPage);}));
    $$('#page [data-pfilter]').forEach(b=>b.addEventListener('click',()=>{paymentFilter=b.dataset.pfilter;renderPage('pagamentos');}));
    $$('#page [data-pfilter-go]').forEach(b=>b.addEventListener('click',()=>{paymentFilter=b.dataset.pfilterGo;currentPage='pagamentos';renderPage('pagamentos');}));
    $('#newEntryPayment')?.addEventListener('click',()=>{const e=state.installments.find(i=>i.type==='entrada');if(e)paymentModal(e.id);});
    $$('#page [data-history-receipt]').forEach(b=>b.addEventListener('click',async()=>{const blob=await getStoredFile(b.dataset.historyReceipt);if(blob)downloadBlob(blob,b.dataset.historyName||'comprovante');else showToast('Arquivo não está disponível.');}));
    $$('#page [data-pay]').forEach(b=>b.addEventListener('click',()=>paymentModal(b.dataset.pay))); $$('#page [data-edit]').forEach(b=>b.addEventListener('click',()=>installmentModal(null,b.dataset.edit))); $$('#page [data-delete]').forEach(b=>b.addEventListener('click',()=>deleteInstallment(b.dataset.delete))); $$('#page [data-receipt]').forEach(b=>b.addEventListener('click',()=>receiptModal(b.dataset.receipt)));
    applyBRMasks($('#page')); $('#simValue')?.addEventListener('input',recalcSim); $('#simCount')?.addEventListener('input',recalcSim); $('#simExtra')?.addEventListener('input',recalcSim); $('#simReset')?.addEventListener('click',()=>{$('#simValue').value='5.000,00';$('#simCount').value=12;$('#simExtra').value='0,00';recalcSim();});
    $('#reportReceipts')?.addEventListener('click',()=>makePDF('receipts')); $('#reportPaid')?.addEventListener('click',()=>makePDF('paid')); $('#reportSchedule')?.addEventListener('click',()=>makePDF('schedule')); $('#reportFull')?.addEventListener('click',()=>makePDF('full')); $('#reportFull2')?.addEventListener('click',()=>makePDF('full')); $('#reportBuyer')?.addEventListener('click',()=>makePDF('buyer'));
    $('#reloadContract')?.addEventListener('click',()=>{if(!confirm('Recarregar o cadastro conforme o contrato? Isso substitui a venda atual e os pagamentos já lançados.'))return;state=seedState();activateSale(state.activeSaleId);saveState();currentPage='dashboard';render();showToast('Cadastro do contrato recarregado.');});
    $('#passwordForm')?.addEventListener('submit',e=>{e.preventDefault();
      const sp=$('#pwSeller').value.trim(), bp=$('#pwBuyer').value.trim();
      if(!sp||!bp){showToast('As duas senhas precisam ser preenchidas.');return;}
      if(sp===bp){if(!confirm('As duas senhas ficaram iguais. Continuar mesmo assim?'))return;}
      state.sellerPassword=sp; state.buyerPassword=bp; saveState(); showToast('Senhas atualizadas.');
    });
    $('#manualSync')?.addEventListener('click',async()=>{if(!supabaseConfigured())return;showToast('Buscando dados mais recentes da nuvem…');const cloud=await pullStateFromSupabase();if(cloud){state=normalizeState(cloud);activateSale(state.activeSaleId);localStorage.setItem(DATA_KEY,JSON.stringify({version:STATE_VERSION,activeSaleId:state.activeSaleId,sales:state.sales,updatedAt:state.updatedAt}));renderPage(currentPage);showToast('Dados atualizados a partir da nuvem.');}else{queueCloudSync();showToast('Nenhum dado novo na nuvem — enviando a cópia local.');}});
    $('#backupExport')?.addEventListener('click',exportBackup); $('#backupExport2')?.addEventListener('click',exportBackup); $('#backupFile')?.addEventListener('change',e=>importBackup(e.target.files[0])); $('#saveGoogleClient')?.addEventListener('click',()=>{const v=$('#googleClientId').value.trim();if(v)localStorage.setItem('zmart_google_client_id',v);showToast(v?'Client ID salvo.':'Informe o Client ID.');}); $('#connectDrive')?.addEventListener('click',connectGoogleDrive); $('#openCalendar')?.addEventListener('click',openCalendar); $('#ghSaveConfig')?.addEventListener('click',()=>{const t=$('#ghToken')?.value.trim(),r=$('#ghRepo')?.value.trim(),b=$('#ghBranch')?.value.trim()||'main';if(t)localStorage.setItem('zmart_gh_token',t);if(r)localStorage.setItem('zmart_gh_repo',r);localStorage.setItem('zmart_gh_branch',b);showToast(t&&r?'Configuração do GitHub salva.':'Preencha token e repositório.');}); $('#ghDeploy')?.addEventListener('click',async()=>{ const token=localStorage.getItem('zmart_gh_token')||''; const repo=localStorage.getItem('zmart_gh_repo')||''; const branch=localStorage.getItem('zmart_gh_branch')||'main'; const file=$('#ghFile')?.files[0]; const st=$('#ghStatus'); if(!token||!repo){showToast('Salve o token e o repositório antes de publicar.');return;} if(!file){showToast('Selecione um arquivo para publicar.');return;} if(!st)return; st.textContent='Lendo arquivo…'; try{ const text=await file.text(); const base64=btoa(unescape(encodeURIComponent(text))); const path=file.name; st.textContent='Buscando SHA atual do arquivo…'; const getRes=await fetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`,{headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}}); let sha=null; if(getRes.ok){const gj=await getRes.json();sha=gj.sha||null;} else if(getRes.status!==404){throw new Error(`GitHub retornou ${getRes.status} ao buscar o arquivo.`);} st.textContent='Enviando para o GitHub…'; const body={message:`deploy: ${path} via ZMART Lar+ app (${new Date().toLocaleString('pt-BR')})`,content:base64,branch}; if(sha)body.sha=sha; const putRes=await fetch(`https://api.github.com/repos/${repo}/contents/${path}`,{method:'PUT',headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','Content-Type':'application/json','X-GitHub-Api-Version':'2022-11-28'},body:JSON.stringify(body)}); if(!putRes.ok){const ej=await putRes.json().catch(()=>({}));throw new Error(ej.message||`Erro ${putRes.status}`);} st.textContent=`✓ ${path} publicado! O GitHub Pages atualiza em instantes.`; showToast(`${path} publicado no GitHub Pages.`); }catch(err){console.error(err);st.textContent='Falha: '+err.message;showToast('Erro ao publicar: '+err.message);}}); $('#paymentReport')?.addEventListener('click',()=>makePDF('paid')); $('#openNext')?.addEventListener('click',()=>{currentPage=next?.type==='entrada'?'entradas':'parcelas';renderPage(currentPage);}); $('#validateNext')?.addEventListener('click',()=>{if(next)paymentModal(next.id);}); $('#nextReceipt')?.addEventListener('click',()=>{if(next)receiptModal(next.id);}); $('#validateEntrada')?.addEventListener('click',()=>{if(entradaParcial)paymentModal(entradaParcial.id);}); $('#entradaReceipt')?.addEventListener('click',()=>{if(entradaParcial)receiptModal(entradaParcial.id);}); $('#goEntradas')?.addEventListener('click',()=>{currentPage='entradas';renderPage('entradas');});
  }

  function recalcSim(){const c=calc(),v=readMoney($('#simValue')),n=Number($('#simCount')?.value||0),extra=readMoney($('#simExtra')),total=v*n+extra,saldo=Math.max(0,c.debt-total),progress=pct(c.paid+total,state.property.total);const el=$('#simResult');if(el)el.innerHTML=`<div><small>Total simulado</small><b>${money(total)}</b></div><div><small>Saldo no cenário</small><b>${money(saldo)}</b></div><div><small>Progresso</small><b>${progress.toFixed(1)}%</b></div>`;}

  function showModal(title,body){const root=$('#modalRoot');root.innerHTML=`<div class="modal-backdrop" id="modalBackdrop"><div class="modal-card" role="dialog" aria-modal="true"><div class="modal-head"><div><span>ZMART Lar+</span><h3>${title}</h3></div><button class="close-btn" id="closeModal" aria-label="Fechar">×</button></div>${body}</div></div>`;$('#closeModal').addEventListener('click',closeModal);$('#modalBackdrop').addEventListener('click',e=>{if(e.target.id==='modalBackdrop')closeModal();});}
  function closeModal(){$('#modalRoot').innerHTML=''; if(modalCleanup){modalCleanup();modalCleanup=null;}}

  function switchSale(id){if(id===state.activeSaleId)return;saveState();if(!state.sales.some(s=>s.id===id))return;activateSale(id);audit('ABRIU_VENDA',state.property.title);saveState();currentPage='dashboard';render();showToast(`Venda ativa: ${state.property.title}`);}
  function redistributePending(items,total){const pending=items.filter(i=>i.status!=='paid');const values=splitExact(total,pending.length);pending.forEach((item,idx)=>{item.value=values[idx]||0;item.status=installmentStatus(item.value,item.received);});}
  function buildPendingSchedule(sale,newTotal,newEntry,rules){
    const paid=sale.installments.filter(i=>i.status==='paid');
    const paidParcel=paid.filter(i=>i.type==='parcela');
    // ENTRADA ÚNICA: a venda tem UM único valor de entrada (newEntry), pago de forma parcial ao longo
    // do tempo, com uma data limite de quitação. Não existem "várias parcelas de entrada" — cada
    // comprovante lançado apenas abate o saldo deste único registro. consolidateEntrada garante isso,
    // preservando tudo que já foi recebido e o histórico, mesmo que o valor cadastrado mude.
    const entradaAtual=sale.installments.find(i=>i.type==='entrada');
    const entradaRecebido=Number(entradaAtual?.received||entradaAtual?.paidValue||0);
    if(newEntry<entradaRecebido-0.01) throw new Error(`A entrada não pode ser menor que o já recebido (${money(entradaRecebido)}).`);
    if(newTotal<paid.reduce((a,i)=>a+Number(i.paidValue||i.value),0)-0.01) throw new Error(`O novo valor não pode ser menor que o total já pago (${money(paid.reduce((a,i)=>a+Number(i.paidValue||i.value),0))}).`);
    if(rules.parcelCount<paidParcel.length) throw new Error(`A quantidade de parcelas não pode ser menor que as ${paidParcel.length} já pagas.`);
    const pendingWithDocs=sale.installments.filter(i=>i.type==='parcela'&&i.status!=='paid'&&i.receipt?.blobId);
    const currentParcelCount=sale.installments.filter(i=>i.type==='parcela').length;
    const oldPlans=normalizeAnnualPlans(sale.schedule?.annualPlans,sale.property.total-sale.property.entryTotal,currentParcelCount);
    const scheduleChanged=Math.abs(Number(sale.property.total)-newTotal)>0.009||rules.parcelCount!==currentParcelCount||String(sale.schedule?.firstDueDate||'')!==String(rules.firstDueDate||'')||Number(sale.schedule?.paymentDayLimit||0)!==Number(rules.paymentDayLimit||0)||JSON.stringify(oldPlans)!==JSON.stringify(rules.annualPlans);
    if(pendingWithDocs.length && scheduleChanged) throw new Error('Existem comprovantes pendentes vinculados a alguma prestação. Valide-os antes de alterar o cronograma das prestações.');
    const parcelTotal=Math.max(0,newTotal-newEntry), totals=annualPlanTotals(rules.annualPlans);
    if(totals.count!==rules.parcelCount) throw new Error(`A soma das quantidades por ano (${totals.count}) precisa ser igual à quantidade total de prestações (${rules.parcelCount}).`);
    if(Math.abs(totals.total-parcelTotal)>0.01) throw new Error(`O cronograma anual soma ${money(totals.total)}, mas o saldo das prestações (imóvel − entrada) é ${money(parcelTotal)}. Ajuste os valores por ano.`);
    const old=sale.installments;
    const next=[];
    const firstDate=rules.firstDueDate||today();
    // Entrada: sempre UM único registro, valor atualizado para newEntry, preservando tudo que já
    // foi recebido e o histórico (mesmo que existissem múltiplos registros de cadastros antigos).
    consolidateEntrada(sale.installments,newEntry,rules.entryDeadline||firstDate).filter(i=>i.type==='entrada').forEach(item=>next.push(item));
    paidParcel.forEach(item=>next.push(item));
    const pendingOld=old.filter(i=>i.type==='parcela'&&i.status!=='paid').sort((a,b)=>a.number-b.number);
    const paidParcelCount=paidParcel.length;
    // CORREÇÃO (bug grave): cada faixa anual (rules.annualPlans) representa a quantidade TOTAL de
    // parcelas daquela faixa (pagas + pendentes). Sem isso, o código sempre gerava um lote NOVO e
    // COMPLETO de pendentes por faixa, sem descontar quantas daquela mesma faixa já tinham sido
    // pagas — cada vez que a venda era salva de novo, a faixa em andamento inchava (ex.: 3 pagas +
    // 6 novas pendentes = 9 numa faixa cadastrada com 6), empurrando todas as datas seguintes.
    const paidCountByYear={};
    paidParcel.forEach(item=>{const y=Number(item.scheduleYear)||0; paidCountByYear[y]=(paidCountByYear[y]||0)+1;});
    // Prestações alinhadas ao primeiro vencimento (mesmo critério do seed): a 1ª parcela cai no
    // firstDueDate, independentemente da entrada — o sinal é pago à parte.
    let pNo=paidParcelCount+1, monthOffset=paidParcelCount;
    rules.annualPlans.forEach((plan,y)=>{
      const tierYear=y+1, alreadyPaidInTier=paidCountByYear[tierYear]||0, toGenerate=Math.max(0,plan.count-alreadyPaidInTier);
      for(let j=0;j<toGenerate;j++){
      const oldPendingItem=pendingOld[pNo-paidParcelCount-1];
      // Preserva qualquer recebimento parcial já registrado nesta posição, recalculando o status
      // contra o novo valor previsto do ano (nunca descarta dinheiro já recebido ao reajustar o plano).
      const newValue=Number(plan.value||0), carriedReceived=Math.min(Number(oldPendingItem?.received||0),newValue);
      next.push({...(oldPendingItem||{}),id:oldPendingItem?.id||uid(),type:'parcela',number:pNo,label:`Parcela ${String(pNo).padStart(2,'0')}`,dueDate:dueDateByMonth(firstDate,monthOffset,rules.paymentDayLimit),value:newValue,status:installmentStatus(newValue,carriedReceived),received:carriedReceived,paidValue:carriedReceived,paidAt:oldPendingItem?.paidAt||'',receipt:oldPendingItem?.receipt||null,note:oldPendingItem?.note||'',history:Array.isArray(oldPendingItem?.history)?oldPendingItem.history:[],scheduleYear:y+1});
      pNo++; monthOffset++;
    }});
    const sorted=next.sort((a,b)=>a.type===b.type?(Number(a.number)-Number(b.number)):a.type==='entrada'?-1:1);
    return sorted;
  }
  function annualEditorHTML(plans){
    return `<div class="annual-editor wide"><div class="annual-head"><div><b>Valores previstos das parcelas por ano</b><small>Cadastre quantas parcelas existem em cada ano e o valor previsto de cada uma.</small></div><button type="button" class="text-link gold-link" id="addAnnualYear">+ adicionar ano</button></div><div id="annualRows">${plans.map((r,idx)=>`<div class="annual-row" data-annual-row><label><span>Ano</span><input class="a-year" type="number" min="1" step="1" value="${r.year||idx+1}"></label><label><span>Qtd. parcelas</span><input class="a-count" type="number" min="1" step="1" value="${r.count||12}"></label><label><span>Valor de cada parcela</span><input class="a-value" type="text" data-money inputmode="decimal" value="${formatMoneyBR(r.value||0)}" placeholder="0,00"></label><button type="button" class="text-link danger-link remove-annual" aria-label="Remover ano">remover</button></div>`).join('')}</div><div class="annual-summary" id="annualSummary"></div></div>`;
  }
  function readAnnualPlans(){return $$('#annualRows [data-annual-row]').map((row,idx)=>({year:Math.max(1,Math.floor(Number($('.a-year',row)?.value)||idx+1)),count:Math.max(0,Math.floor(Number($('.a-count',row)?.value)||0)),value:Math.max(0,parseBRMoney($('.a-value',row)?.value))})).filter(r=>r.count>0);}
  function refreshAnnualSummary(){const rows=readAnnualPlans(), t=annualPlanTotals(rows), parcelCount=Math.max(0,Math.floor(Number($('#sParcelCount')?.value)||0)), parcelTotal=Math.max(0,readMoney($('#sTotal'))-readMoney($('#sEntry')));const diff=t.total-parcelTotal;const el=$('#annualSummary');if(el)el.innerHTML=`<span><b>${t.count}</b> parcelas cadastradas</span><span><b>${money(t.total)}</b> no cronograma</span><span class="${Math.abs(diff)<=0.01?'ok':'bad'}"><b>${money(diff)}</b> diferença para o saldo</span><small>${t.count===parcelCount&&Math.abs(diff)<=0.01?'Cronograma consistente.':'Ajuste quantidade e valores até a soma coincidir exatamente com o saldo das parcelas.'}</small>`;}
  function bindAnnualEditor(){
    const rows=$('#annualRows'); if(!rows)return;
    $$('#annualRows input').forEach(el=>el.addEventListener('input',refreshAnnualSummary));
    $$('#annualRows .remove-annual').forEach(btn=>btn.addEventListener('click',()=>{const all=$$('#annualRows [data-annual-row]');if(all.length<=1){showToast('Mantenha pelo menos um ano de parcelas.');return;}btn.closest('[data-annual-row]').remove();refreshAnnualSummary();}));
    $('#addAnnualYear')?.addEventListener('click',()=>{const n=$$('#annualRows [data-annual-row]').length+1;const row=document.createElement('div');row.className='annual-row';row.dataset.annualRow='';row.innerHTML=`<label><span>Ano</span><input class="a-year" type="number" min="1" step="1" value="${n}"></label><label><span>Qtd. parcelas</span><input class="a-count" type="number" min="1" step="1" value="12"></label><label><span>Valor de cada parcela</span><input class="a-value" type="text" data-money inputmode="decimal" value="0,00" placeholder="0,00"></label><button type="button" class="text-link danger-link remove-annual">remover</button>`;rows.appendChild(row);applyBRMasks(row);bindAnnualEditor();refreshAnnualSummary();});
    refreshAnnualSummary();
  }
  function saleModal(id=null){
    if(role!=='vendedor')return;
    const sale=id?state.sales.find(s=>s.id===id):null;
    const p=sale?.property||{title:'',total:0,entryTotal:0,description:''};
    const sc=sale?.schedule||{entryCount:sale?.installments?.filter(i=>i.type==='entrada').length||5,parcelCount:sale?.installments?.filter(i=>i.type==='parcela').length||60,firstDueDate:sale?.installments?.find(i=>i.type==='parcela')?.dueDate||today(),paymentDayLimit:new Date((sale?.installments?.find(i=>i.dueDate)?.dueDate||today())+'T00:00:00').getDate(),lateInterestRate:0,lateInterestPeriod:'monthly'};
    const plans=normalizeAnnualPlans(sc.annualPlans,(Number(p.total)||0)-(Number(p.entryTotal)||0),Number(sc.parcelCount)||0);
    showModal(sale?'Editar venda':'Nova venda',`<form id="saleForm" class="form-grid">
      <label class="field wide"><span>Nome da venda</span><input id="sTitle" value="${esc(p.title)}" required placeholder="Ex.: Apartamento Centro — Cliente A"></label>
      <label class="field"><span>Valor total do imóvel</span><input id="sTotal" type="text" data-money inputmode="decimal" value="${p.total?formatMoneyBR(p.total):''}" placeholder="0,00" required></label>
      <label class="field"><span>Valor total da entrada</span><input id="sEntry" type="text" data-money inputmode="decimal" value="${formatMoneyBR(p.entryTotal||0)}" placeholder="0,00" required><small class="helper">Entrada é bloco livre: gerencie cada parcela na página <b>Entradas</b>. Este valor define apenas o saldo das prestações (imóvel − entrada).</small></label>
      <label class="field"><span>Data limite de quitação da entrada</span><input id="sEntryDeadline" type="text" data-date inputmode="numeric" value="${sc.entryDeadline?formatDateBRInput(sc.entryDeadline):''}" placeholder="DD/MM/AAAA" maxlength="10"><small class="helper">Até quando a entrada deve estar totalmente quitada. Opcional.</small></label>
      <label class="field"><span>Quantidade total de prestações</span><input id="sParcelCount" type="number" min="0" step="1" value="${sc.parcelCount||0}" required></label>
      <label class="field"><span>Primeiro vencimento das prestações</span><input id="sFirstDue" type="text" data-date inputmode="numeric" value="${formatDateBRInput(sc.firstDueDate||today())}" placeholder="DD/MM/AAAA" maxlength="10" required></label>
      <label class="field"><span>Dia limite de pagamento</span><input id="sPaymentDay" type="number" min="1" max="31" step="1" value="${sc.paymentDayLimit||1}" required><small class="helper">Quando o mês não possui esse dia, vale o último dia do mês.</small></label>
      <label class="field"><span>Juros por atraso (%)</span><input id="sLateRate" type="number" min="0" step="0.0001" value="${Number(sc.lateInterestRate||0)}"></label>
      <label class="field"><span>Período da taxa</span><select id="sLatePeriod"><option value="monthly" ${sc.lateInterestPeriod!=='daily'?'selected':''}>ao mês</option><option value="daily" ${sc.lateInterestPeriod==='daily'?'selected':''}>ao dia</option></select></label>
      ${annualEditorHTML(plans)}
      <label class="field wide"><span>Descrição / contrato</span><textarea id="sDesc" rows="3">${esc(p.description||'')}</textarea></label>
      <div class="validation-warning wide"><b>Regra financeira:</b> os valores das prestações por ano precisam somar exatamente <b>valor do imóvel − entrada</b>. A <b>entrada é independente</b>: você edita valor, data e quantidade de cada parcela de entrada na página Entradas, sem trava. Pagamentos já validados nunca são apagados.</div>
      <div class="form-actions wide"><button type="button" class="text-link" id="cancelSale">cancelar</button><button class="primary-link" type="submit">${sale?'salvar venda':'criar venda'}</button></div>
    </form>`);
    applyBRMasks($('#saleForm'));
    bindAnnualEditor();
    $('#sTotal')?.addEventListener('input',refreshAnnualSummary); $('#sEntry')?.addEventListener('input',refreshAnnualSummary); $('#sParcelCount')?.addEventListener('input',refreshAnnualSummary);
    $('#cancelSale').addEventListener('click',closeModal);
    $('#saleForm').addEventListener('submit',e=>{e.preventDefault();
      const total=readMoney($('#sTotal')),entry=readMoney($('#sEntry')),parcelCount=Math.max(0,Math.floor(Number($('#sParcelCount').value||0))),firstDue=readDate($('#sFirstDue'))||today(),entryDeadline=readDate($('#sEntryDeadline'))||'',paymentDay=Math.max(1,Math.min(31,Math.floor(Number($('#sPaymentDay').value||1)))),lateRate=Math.max(0,Number($('#sLateRate').value||0)),latePeriod=$('#sLatePeriod').value==='daily'?'daily':'monthly',annualPlans=readAnnualPlans(),totals=annualPlanTotals(annualPlans);
      if(total<=0||entry<0||entry>total){showToast('Revise os valores: a entrada não pode superar o valor do imóvel.');return;}
      if(total-entry>0&&parcelCount===0){showToast('Informe a quantidade de prestações para o saldo restante.');return;}
      if(totals.count!==parcelCount){showToast(`A quantidade por ano (${totals.count}) precisa ser igual a ${parcelCount} prestações.`);return;}
      if(Math.abs(totals.total-(total-entry))>0.01){showToast(`O cronograma anual precisa somar exatamente ${money(total-entry)} (imóvel − entrada).`);return;}
      const rules={parcelCount,firstDueDate:firstDue,entryDeadline,paymentDayLimit:paymentDay,lateInterestRate:lateRate,lateInterestPeriod:latePeriod,annualPlans};
      try{
        if(sale){const newInstallments=buildPendingSchedule(sale,total,entry,rules);sale.property={title:$('#sTitle').value.trim()||'Venda do imóvel',total,entryTotal:entry,description:$('#sDesc').value.trim()};sale.installments=newInstallments;sale.schedule=rules;if(sale.id===state.activeSaleId)activateSale(sale.id);auditSale(sale,'ATUALIZOU_VENDA',`${sale.property.title} · ${money(total)} · cronograma anual atualizado`);saveState();closeModal();render();showToast('Venda atualizada preservando pagamentos e comprovantes.');}
        else {const n=seedSale($('#sTitle').value.trim()||'Nova venda',total,entry,parcelCount,entry>0?1:0,firstDue);n.property.description=$('#sDesc').value.trim();n.schedule={...rules,entryCount:entry>0?1:0};n.installments=consolidateEntrada(makeInstallments(entry,entry>0?1:0,firstDue,{...rules,entryCount:entry>0?1:0,totalParcelValue:total-entry,parcelStartOffset:0}),entry,entryDeadline||firstDue);auditSale(n,'CRIOU_VENDA',n.property.title);state.sales.push(n);saveState();closeModal();currentPage='vendas';render();showToast('Venda criada.');}
      }catch(err){showToast(err.message||'Não foi possível salvar a venda.');}
    });
  }
  function deleteSale(id){if(role!=='vendedor'||state.sales.length<=1)return;const sale=state.sales.find(s=>s.id===id);if(!sale)return;const paid=sale.installments.filter(i=>i.status==='paid').length;if(paid&&!confirm(`A venda possui ${paid} pagamento(s) validado(s). Excluir mesmo assim?`))return;if(!paid&&!confirm(`Excluir a venda “${sale.property.title}”?`))return;state.sales=state.sales.filter(s=>s.id!==id);if(state.activeSaleId===id)activateSale(state.sales[0].id);auditSale(sale,'EXCLUIU_VENDA',sale.property.title);saveState();currentPage='vendas';render();showToast('Venda excluída.');}

  function installmentModal(forceType=null,id=null){
    if(role!=='vendedor')return; const item=id?state.installments.find(i=>i.id===id):null; const type=item?.type||forceType||'parcela'; showModal(item?'Editar lançamento':'Novo lançamento',`<form id="installmentForm" class="form-grid"><label class="field"><span>Tipo</span><select id="iType"><option value="parcela" ${type==='parcela'?'selected':''}>Parcela</option><option value="entrada" ${type==='entrada'?'selected':''}>Entrada</option></select></label><label class="field"><span>Descrição</span><input id="iLabel" value="${esc(item?.label||'') }" placeholder="Ex.: Parcela 07" required></label><label class="field"><span>Vencimento</span><input id="iDate" type="text" data-date inputmode="numeric" value="${formatDateBRInput(item?.dueDate||today())}" placeholder="DD/MM/AAAA" maxlength="10" required></label><label class="field"><span>Valor previsto</span><input id="iValue" type="text" data-money inputmode="decimal" value="${formatMoneyBR(item?.value??5000)}" placeholder="0,00" required></label><label class="field wide"><span>Observação</span><textarea id="iNote" rows="3">${esc(item?.note||'')}</textarea></label><div class="form-actions wide"><button type="button" class="text-link" id="cancelModal">cancelar</button><button class="primary-link" type="submit">${item?'salvar alterações':'criar lançamento'}</button></div></form>`);applyBRMasks($('#installmentForm'));$('#cancelModal').addEventListener('click',closeModal);$('#installmentForm').addEventListener('submit',e=>{e.preventDefault();const newValue=readMoney($('#iValue')),received=Number(item?.received||0);const obj={id:item?.id||uid(),type:$('#iType').value==='entrada'?'entrada':'parcela',number:item?.number||nextNumber($('#iType').value==='entrada'?'entrada':'parcela'),label:$('#iLabel').value.trim(),dueDate:readDate($('#iDate'))||today(),value:newValue,status:installmentStatus(newValue,received),received,paidValue:received,paidAt:item?.paidAt||'',receipt:item?.receipt||null,note:$('#iNote').value.trim(),history:Array.isArray(item?.history)?item.history:[]};state.installments=item?state.installments.map(x=>x.id===item.id?obj:x):[...state.installments,obj];saveState();closeModal();renderPage(currentPage);showToast(item?'Alterações salvas.':'Lançamento criado.');});}
  function nextNumber(type){const nums=state.installments.filter(i=>i.type===type).map(i=>Number(i.number)||0);return (Math.max(0,...nums)+1);}
  function paymentModal(id){
    if(role!=='vendedor')return; const i=state.installments.find(x=>x.id===id); if(!i)return;
    const hasReceipt=!!i.receipt?.blobId;
    showModal(i.status==='paid'?'Editar pagamento':'Validar recebimento',`<form id="payForm"><div class="payment-focus"><span>${esc(i.label)}</span><strong>${money(i.value)}</strong><small>Vencimento ${dateBR(i.dueDate)} · limite dia ${Number(state.schedule?.paymentDayLimit||1)}</small>${i.status==='partial'?`<small class="late-note">Já recebido: ${money(i.received)} · falta ${money(installmentBalance(i))}</small>`:''}${i.status!=='paid'&&effectiveDueDate(i)<today()&&lateInterest(i)?`<small class="late-note">Juros estimados pelo atraso: ${money(lateInterest(i))} · total teórico ${money(i.value+lateInterest(i))}</small>`:''}</div><label class="field"><span>Valor recebido${i.status==='partial'?' (deste recebimento)':''}</span><input id="payValue" type="text" data-money inputmode="decimal" value="${formatMoneyBR(i.status==='paid'?i.paidValue:i.status==='partial'?installmentBalance(i):i.value)}" placeholder="0,00" required></label><label class="field"><span>Data do recebimento</span><input id="payDate" type="text" data-date inputmode="numeric" value="${formatDateBRInput(i.status==='paid'?i.paidAt:today())}" placeholder="DD/MM/AAAA" maxlength="10" required></label><label class="field"><span>Comprovante original</span><input id="payReceipt" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" ${i.status==='paid'?'':'required'}></label><small class="helper">Para validar um pagamento novo, o comprovante original é obrigatório. PDF e JPG/PNG são aceitos; o original fica preservado.</small><label class="field"><span>Observação</span><textarea id="payNote" rows="3">${esc(i.note||'')}</textarea></label><div class="form-actions"><button type="button" class="text-link" id="cancelPay">cancelar</button><button class="primary-link green-button" type="submit">${i.status==='paid'?'salvar pagamento':'ler comprovante e validar'}</button></div></form>`);
    applyBRMasks($('#payForm'));
    $('#cancelPay').addEventListener('click',closeModal);
    $('#payForm').addEventListener('submit',async e=>{
      e.preventDefault(); const value=readMoney($('#payValue')), date=readDate($('#payDate'))||today(), file=$('#payReceipt').files[0];
      if(value<=0){showToast('Informe um valor recebido maior que zero.');return;}
      if(i.status!=='paid' && !file){showToast('Anexe o comprovante original para validar.');return;}
      try{
        if(file){const parsed=await parseReceiptFile(file);const paymentKey=i.id+'_p_'+uid();const receiptRef=await saveOriginalReceiptFor(file,i.id,paymentKey,parsed);i.receipt={...(i.receipt||{}),validation:{status:'review',source:'payment-form'}};const noteVal=$('#payNote')?.value?.trim()||'';
        // Passa null como enteredDate quando há comprovante: o modal de revisão deve usar a data
        // lida do comprovante (p.date) como fonte primária, protegendo o comprador de penalidades
        // causadas por lançamentos tardios do vendedor.
        closeModal();reviewAndValidateModal(i.id,parsed,value,null,noteVal,receiptRef);}
        else {
          // Sem comprovante: verifica se a data digitada está fora das janelas de vencimento.
          // Se a data informada for futura ou posterior ao vencimento em mais de 30 dias,
          // pergunta ao vendedor se a data está correta para não punir o comprador.
          const _manualLate=lateDays({dueDate:i.dueDate},date);
          if(_manualLate>30 && date>i.dueDate){
            if(!confirm(`Atenção: a data informada (${dateBR(date)}) é ${_manualLate} dias após o vencimento (${dateBR(i.dueDate)}).\n\nIsso registrará atraso para o comprador.\n\nA data está correta? Clique OK para confirmar ou Cancelar para corrigir.`))return;
          }
          i.received=Number(value.toFixed(2));i.paidValue=i.received;i.paidAt=date;i.status=installmentStatus(i.value,i.received);i.note=$('#payNote').value.trim();i.history=Array.isArray(i.history)?i.history:[];const lateD2=lateDays({dueDate:i.dueDate},date);const lateI2=lateD2>0?lateInterest({dueDate:i.dueDate,value:i.value},date):0;i.history.push({amount:value,date,note:'edição manual',at:new Date().toISOString(),edit:true,lateDays:lateD2,lateInterest:lateI2});if(lateD2>0){i.paidLate=true;i.lateDaysOnPayment=lateD2;i.lateInterestCharged=lateI2;}else{i.paidLate=false;i.lateDaysOnPayment=0;i.lateInterestCharged=0;}audit('EDITOU_PAGAMENTO',i.label);saveState();closeModal();renderPage(currentPage);showToast('Pagamento atualizado.');}
      }catch(err){console.error(err);showToast(err.message||'Não foi possível processar o comprovante.');}
    });
  }

  async function receiptModal(id){
    const i=state.installments.find(x=>x.id===id); if(!i)return; const canAdd=role==='vendedor'; const r=i.receipt;
    const existing=r?`<div class="receipt-box"><strong>📎 ${esc(r.originalName||r.name||'Comprovante')}</strong><small>${formatBytes(r.size)} · ${esc(r.type||'arquivo')} · ${r.validation?.status==='validated'?'Validação concluída':r.validation?.status==='review'?'Aguardando revisão':'Anexado'}</small>${r.extracted?`<div class="extracted-grid"><span>Valor <b>${r.extracted.amount?money(r.extracted.amount):'—'}</b></span><span>Data <b>${r.extracted.date?dateBR(r.extracted.date):'—'}</b></span><span>Pagador <b>${esc(r.extracted.payerName||'—')}</b></span><span>Recebedor <b>${esc(r.extracted.receiverName||'—')}</b></span><span>Situação <b>${esc(r.extracted.transactionStatus||'—')}</b></span><span>Transação <b>${esc(r.extracted.transactionId||'—')}</b></span></div>`:''}<div class="receipt-links"><button class="text-link" id="downloadReceipt">abrir original</button>${r.generatedBlobId?`<button class="text-link" id="downloadGenerated">recibo ZMART</button>`:''}${r.combinedBlobId?`<button class="text-link green-link" id="downloadCombined">comprovante completo</button>`:''}${canAdd&&!r.driveFileId?`<button class="text-link green-link" id="driveOne">enviar ao Drive</button>`:''}</div>${r.validation?.issues?.length?`<div class="validation-warning"><b>Alertas</b><ul>${r.validation.issues.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div>`:''}</div>`:`<div class="empty-card">Nenhum comprovante anexado.</div>`;
    showModal(`Comprovante · ${esc(i.label)}`,`${existing}${canAdd?`<form id="receiptForm"><label class="field"><span>PDF, JPG, PNG ou WEBP</span><input id="receiptFile" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" required></label><small class="helper">O sistema tenta extrair texto; se o PDF for uma imagem, aplica OCR. O arquivo original nunca é substituído.</small><div id="receiptStatus" class="parse-status">Aguardando arquivo.</div><div class="form-actions"><button class="text-link" type="button" id="cancelReceipt">cancelar</button><button class="primary-link" type="submit">processar comprovante</button></div></form>`:''}`);
    $('#cancelReceipt')?.addEventListener('click',closeModal);
    $('#downloadReceipt')?.addEventListener('click',async()=>{const blob=await getStoredFile(r?.blobId);if(blob)downloadBlob(blob,r.originalName||r.name||'comprovante');else showToast('Arquivo original não está disponível.');});
    $('#downloadGenerated')?.addEventListener('click',async()=>{const blob=await getStoredFile(r?.generatedBlobId);if(blob)downloadBlob(blob,r.generatedName||'ZMART-recibo.pdf');});
    $('#downloadCombined')?.addEventListener('click',async()=>{const blob=await getStoredFile(r?.combinedBlobId);if(blob)downloadBlob(blob,r.combinedName||'ZMART-comprovante-completo.pdf');});
    $('#driveOne')?.addEventListener('click',async()=>{await uploadReceiptToDrive(i.id);closeModal();});
    $('#receiptForm')?.addEventListener('submit',async e=>{e.preventDefault();const f=$('#receiptFile').files[0];if(!f)return;if(f.size>Number(state.settings?.maxFileMB||20)*1024*1024){showToast(`Arquivo maior que ${state.settings.maxFileMB||20} MB.`);return;}const st=$('#receiptStatus');st.textContent='Processando…';try{const parsed=await parseReceiptFile(f,st);await saveOriginalReceipt(f,i.id,parsed);closeModal();reviewAndValidateModal(i.id,parsed,i.status==='paid'?i.paidValue:i.status==='partial'?installmentBalance(i):i.value,i.status==='paid'?i.paidAt:today(),i.note||'');}catch(err){console.error(err);st.textContent='Falha: '+err.message;showToast(err.message||'Não foi possível processar o arquivo.');}});
  }

  async function importReceiptModal(){
    if(role!=='vendedor')return;
    showModal('Importar comprovante',`<form id="importPdfForm"><label class="field"><span>Comprovante original</span><input id="importPdfFile" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" required></label><small class="helper">Aceita PDF, JPG, PNG e WEBP. PDFs de banco que são apenas imagem passam por OCR. O sistema não considera o documento validado sem revisão.</small><div id="pdfReadStatus" class="parse-status">Aguardando arquivo.</div><div class="form-actions"><button class="text-link" type="button" id="cancelImport">cancelar</button><button class="primary-link" type="submit">ler e preencher</button></div></form>`);
    $('#cancelImport').addEventListener('click',closeModal);
    $('#importPdfForm').addEventListener('submit',async e=>{e.preventDefault();const f=$('#importPdfFile').files[0];if(!f)return;const st=$('#pdfReadStatus');try{if(f.size>Number(state.settings?.maxFileMB||20)*1024*1024)throw new Error(`Arquivo maior que ${state.settings.maxFileMB||20} MB.`);const parsed=await parseReceiptFile(f,st);let item=findInstallmentMatch(parsed.extracted);if(!item){const inboxId=uid(),blobId='inbox_'+inboxId;await putStoredFile(blobId,f);state.receiptInbox=state.receiptInbox||[];state.receiptInbox.push({id:inboxId,blobId,originalName:f.name,size:f.size,type:f.type,createdAt:new Date().toISOString(),parsed});audit('RECEBIMENTO_SEM_CONCILIACAO',f.name);saveState();closeModal();showToast('Comprovante guardado: nenhum lançamento foi alterado.');renderPage('recibos');return;}await saveOriginalReceipt(f,item.id,parsed);saveState();closeModal();reviewAndValidateModal(item.id,parsed,parsed.extracted.amount||item.value,parsed.extracted.date||today(),'');}catch(err){console.error(err);st.textContent='Não foi possível processar: '+err.message;}});
  }

  function findInstallmentMatch(p){
    const amount=Number(p?.amount||0), ref=String(p?.reference||'').toUpperCase(), date=p?.date||'';
    const candidates=state.installments.filter(i=>i.status!=='paid');
    let best=null,bestScore=-1;
    candidates.forEach(i=>{let score=0;if(amount>0&&Math.abs(Number(i.value)-amount)<=Math.max(.01,Number(state.settings?.validationTolerance||.01)))score+=6;if(ref&&(new RegExp('\\b0*'+String(i.number)+'\\b').test(ref)||ref.includes(i.label.toUpperCase())))score+=5;if(date&&i.dueDate===date)score+=2;if(i.type==='entrada'&&/ENTRADA/.test(ref))score+=2;if(i.type==='parcela'&&/(PARCELA|PRESTACAO|PRESTAÇÃO)/.test(ref))score+=2;if(score>bestScore){bestScore=score;best=i;}});
    return bestScore>=5?best:null;
  }

  async function parseReceiptFile(file,statusEl=null){
    if(isPdfFile(file)) return parseReceiptPDF(file,statusEl);
    if(isImageFile(file)) return parseReceiptImage(file,statusEl);
    throw new Error('Formato não suportado. Use PDF, JPG, PNG ou WEBP.');
  }

  async function parseReceiptPDF(file,statusEl=null){
    await loadPdfJs(); const buf=await file.arrayBuffer(); const pdf=await window.pdfjsLib.getDocument({data:new Uint8Array(buf),disableWorker:true}).promise; let text=''; let pages=0;
    for(let n=1;n<=pdf.numPages;n++){const page=await pdf.getPage(n);const tc=await page.getTextContent();text+=tc.items.map(x=>x.str).join(' ')+'\n';pages++;}
    if(text.replace(/\s/g,'').length>20){return {text,extracted:extractReceiptFields(text),method:'pdf-text',pages};}
    // Image-only bank receipt: render and OCR locally in the browser.
    let ocrText=''; const maxPages=Math.min(pdf.numPages,10);
    for(let n=1;n<=maxPages;n++){if(statusEl)statusEl.textContent=`OCR do PDF: página ${n} de ${maxPages}…`;const page=await pdf.getPage(n);const viewport=page.getViewport({scale:2.2});const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;const res=await ocrImageSource(canvas,statusEl);ocrText+=res.text+'\n';}
    return {text:ocrText,extracted:extractReceiptFields(ocrText),method:'pdf-ocr',pages};
  }

  async function parseReceiptImage(file,statusEl=null){if(statusEl)statusEl.textContent='OCR da imagem…';const res=await ocrImageSource(file,statusEl);return {text:res.text,extracted:extractReceiptFields(res.text),method:'image-ocr',pages:1};}

  async function ocrImageSource(source,statusEl=null){await loadTesseract();const result=await window.Tesseract.recognize(source,'por',{logger:m=>{if(statusEl&&m?.status&&typeof m.progress==='number')statusEl.textContent=`OCR: ${m.status} ${Math.round(m.progress*100)}%`;}});return {text:result.data?.text||'',confidence:Number(result.data?.confidence||0)/100};}

  function extractReceiptFields(text){
    const raw=String(text||'').replace(/\r/g,'\n');
    const norm=raw.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
    const lines=norm.split(/\n+/).map(x=>x.trim()).filter(Boolean);
    const out={amount:0,date:'',time:'',payerName:'',payerDoc:'',receiverName:'',receiverDoc:'',reference:'',paymentMethod:'PIX',property:'',transactionStatus:'',transactionId:'',operationCode:'',securityKey:'',pixKey:'',note:'',confidence:0};
    const clean=x=>String(x||'').replace(/^[\s:–—-]+/,'').trim();
    const section=(startLabels,endLabels)=>{const a=lines.findIndex(x=>startLabels.some(l=>x.includes(l)));if(a<0)return [];let b=lines.length;for(let j=a+1;j<lines.length;j++){if(endLabels.some(l=>lines[j].includes(l))){b=j;break;}}return lines.slice(a+1,b);};
    const valueAfter=(arr,labels)=>{for(let i=0;i<arr.length;i++){if(labels.some(l=>arr[i]===l||arr[i].startsWith(l+':'))){const same=clean(arr[i].split(':').slice(1).join(':'));if(same)return same;const next=arr[i+1]||'';if(next&&!['NOME','CPF','CNPJ','INSTITUICAO','SITUACAO','VALOR','DATA','DATA/ HORA','ID TRANSACAO','CODIGO DA OPERACAO','CODIGO','CHAVE DE SEGURANCA','CHAVE PIX','FORMA DE PAGAMENTO','MEIO DE PAGAMENTO','REFERENCIA','CONTRATO','PEDIDO'].some(l=>next===l||next.startsWith(l+' ')))return clean(next);return '';}}return '';};
    const amountPatterns=[/(?:VALOR(?:\s+(?:RECEBIDO|PAGO|DA\s+TRANSACAO))?|TOTAL(?:\s+PAGO)?|R\$|RS)\s*[:\-]?\s*([0-9]{1,3}(?:\.[0-9]{3})*,[0-9]{2}|[0-9]+(?:,[0-9]{2})?)/, /\b([0-9]{1,3}(?:\.[0-9]{3})*,[0-9]{2})\b/];
    for(const re of amountPatterns){const m=norm.match(re);if(m){out.amount=parseBRMoney(m[1]);if(out.amount>0)break;}}
    const dm=norm.match(/\b(\d{2})[\/-](\d{2})[\/-](\d{4})\b/);if(dm)out.date=`${dm[3]}-${dm[2]}-${dm[1]}`;
    const tm=norm.match(/\b(\d{2}:\d{2}(?::\d{2})?)\b/);if(tm)out.time=tm[1];
    const receiver=section(['DADOS DO RECEBEDOR'],['DADOS DO PAGADOR']);
    const payer=section(['DADOS DO PAGADOR'],['DADOS DA TRANSACAO','DADOS DA TRANSAÇÃO']);
    const transaction=section(['DADOS DA TRANSACAO','DADOS DA TRANSAÇÃO'],[]);
    out.receiverName=valueAfter(receiver,['NOME']); out.payerName=valueAfter(payer,['NOME']);
    out.receiverDoc=valueAfter(receiver,['CPF','CNPJ']); out.payerDoc=valueAfter(payer,['CPF','CNPJ']);
    out.receiverDoc=out.receiverDoc||((receiver.join(' ').match(/\b\*{2,}\.\d{3}\.\d{3}-?\*{2,}\b/)||[])[0]||'');
    out.payerDoc=out.payerDoc||((payer.join(' ').match(/\b\*{2,}\.\d{3}\.\d{3}-?\*{2,}\b/)||[])[0]||'');
    out.transactionStatus=valueAfter(transaction,['SITUACAO','SITUACAO DA TRANSACAO'])||(/EFETIVADA/.test(norm)?'EFETIVADA':'');
    out.transactionId=valueAfter(transaction,['ID TRANSACAO','ID DA TRANSACAO','IDENTIFICACAO DA TRANSACAO']);
    out.operationCode=valueAfter(transaction,['CODIGO DA OPERACAO','CODIGO OPERACAO']);
    out.securityKey=valueAfter(transaction,['CHAVE DE SEGURANCA','CHAVE SEGURANCA']);
    out.pixKey=valueAfter(transaction,['CHAVE PIX']);
    out.reference=valueAfter(transaction,['PARCELA','PRESTACAO','REFERENCIA','CONTRATO','PEDIDO']);
    if(/PIX/.test(norm))out.paymentMethod='PIX';
    if(/CAIXA ECONOMICA FEDERAL/.test(norm))out.note='Documento compatível com recibo CAIXA/Pix.';
    const vals=[out.amount,out.date,out.payerName,out.receiverName,out.transactionStatus,out.transactionId].filter(Boolean).length;out.confidence=Math.min(1,vals/6);
    return out;
  }

  async function reviewAndValidateModal(id,parsed,enteredAmount=0,enteredDate=today(),note='',receiptRef=null){
    const i=state.installments.find(x=>x.id===id);if(!i)return;const p=parsed?.extracted||{};const expected=Number(i.value||0), amount=Number(enteredAmount||p.amount||expected);const delta=p.amount?Math.abs(Number(p.amount)-amount):0;const issues=[];
    if(p.transactionStatus && !/EFETIVADA|CONCLUIDA|CONFIRMADA|PAGO/.test(String(p.transactionStatus).toUpperCase()))issues.push(`Situação do comprovante: ${p.transactionStatus}.`);
    if(p.amount&&Math.abs(p.amount-expected)>Math.max(.01,Number(state.settings?.validationTolerance||.01)))issues.push(`Valor do comprovante (${money(p.amount)}) difere do valor previsto (${money(expected)}).`);
    if(p.amount&&Math.abs(p.amount-amount)>Math.max(.01,Number(state.settings?.validationTolerance||.01)))issues.push(`Valor informado (${money(amount)}) difere do valor lido (${money(p.amount)}).`);
    if(!p.amount)issues.push('O valor não foi identificado automaticamente.'); if(!p.date)issues.push('A data não foi identificada automaticamente.');
    // Alerta de divergência entre data do comprovante e data de lançamento informada pelo vendedor.
    // A data do comprovante é a fonte de verdade — o comprador não pode ser penalizado por atraso
    // de lançamento do vendedor. Se divergirem e a data informada for MAIS TARDIA que a do
    // comprovante, o sistema avisa e força o uso da data correta por padrão.
    if(p.date && enteredDate && p.date !== enteredDate && p.date < enteredDate){
      issues.push(`⚠ A data do lançamento (${dateBR(enteredDate)}) é mais tardia que a data do comprovante (${dateBR(p.date)}). O sistema usará a data do comprovante para não penalizar o comprador.`);
      enteredDate = p.date; // corrige silenciosamente — o campo já vai exibir a data certa
    }
    i.receipt={...(i.receipt||{}),validation:{status:'review',issues,ocrMethod:parsed.method,ocrConfidence:parsed.confidence||p.confidence||0}};saveState();
    showModal('Validar comprovante',`<div class="import-review-note"><b>O sistema não valida sozinho.</b> Revise os dados lidos do documento. O original permanecerá anexado ao pagamento.</div><form id="reviewReceiptForm" class="form-grid"><label class="field"><span>Valor recebido</span><input id="rAmount" type="text" data-money inputmode="decimal" value="${formatMoneyBR(amount)}" placeholder="0,00" required></label><label class="field"><span>Data do recebimento</span><input id="rDate" type="text" data-date inputmode="numeric" value="${formatDateBRInput(p.date||enteredDate||today())}" placeholder="DD/MM/AAAA" maxlength="10" required><small class="helper">${p.date?'📄 Data extraída do comprovante — fonte correta. Altere somente se o OCR errou.':`Informe a data exata do comprovante (não a data de lançamento).`}</small></label><label class="field"><span>Pagador</span><input id="rPayer" value="${esc(p.payerName||'')}" ></label><label class="field"><span>CPF/CNPJ do pagador</span><input id="rPayerDoc" value="${esc(p.payerDoc||'')}"></label><label class="field"><span>Recebedor</span><input id="rReceiver" value="${esc(p.receiverName||'')}"></label><label class="field"><span>CPF/CNPJ do recebedor</span><input id="rReceiverDoc" value="${esc(p.receiverDoc||'')}"></label><label class="field"><span>Referência / parcela</span><input id="rReference" value="${esc(p.reference||i.label)}"></label><label class="field"><span>Forma de pagamento</span><input id="rMethod" value="${esc(p.paymentMethod||'PIX')}"></label><label class="field"><span>Situação da transação</span><input id="rStatus" value="${esc(p.transactionStatus||'')}" placeholder="EFETIVADA"></label><label class="field"><span>ID da transação</span><input id="rTxId" value="${esc(p.transactionId||'')}"></label><label class="field wide"><span>Imóvel / contrato</span><input id="rProperty" value="${esc(p.property||state.property.title)}"></label><label class="field wide"><span>Observações</span><textarea id="rNote" rows="3">${esc(note||i.note||'')}</textarea></label><div class="field wide">${issues.length?`<div class="validation-warning"><b>Alertas detectados</b><ul>${issues.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div>`:`<div class="validation-ok">Nenhuma divergência crítica detectada.</div>`}<div class="confidence-bar"><i style="width:${Math.round((p.confidence||0)*100)}%"></i></div><small class="helper">Confiança da extração: ${Math.round((p.confidence||0)*100)}%. Confiança do OCR não substitui conferência humana.</small></div><div class="form-actions wide"><button class="text-link" type="button" id="cancelReview">cancelar</button><button class="primary-link green-button" type="submit">confirmar validação</button></div></form>`);
    $('#cancelReview').addEventListener('click',closeModal);
    applyBRMasks($('#reviewReceiptForm'));
    $('#reviewReceiptForm').addEventListener('submit',async e=>{e.preventDefault();const finalAmount=readMoney($('#rAmount')),finalDate=readDate($('#rDate'))||today();if(finalAmount<=0){showToast('Valor inválido.');return;}
      // O que falta para este lançamento é o SALDO real (valor − já recebido), não o valor cheio —
      // essencial para permitir vários recebimentos parciais até a quitação.
      const saldo=installmentBalance(i);
      const excedente=(i.type==='parcela' && saldo>0)?Number((finalAmount-saldo).toFixed(2)):0;
      // Se o comprovante da PRESTAÇÃO tem valor acima do saldo devido, registra a prestação até
      // completar o saldo (parcial vira pago) e encadeia o excedente: entrada -> multa/amortização.
      const aplicarExcedente = excedente>0.001;
      const valorPrestacao = aplicarExcedente ? saldo : finalAmount;
      if(!aplicarExcedente && saldo>0 && finalAmount>saldo*1.001 && i.type!=='parcela'){if(!confirm(`O valor recebido (${money(finalAmount)}) supera o saldo previsto (${money(saldo)}). Confirmar mesmo assim?`))return;}
      applyPayment(i,valorPrestacao,finalDate,$('#rNote').value.trim(),receiptRef);
      i.note=$('#rNote').value.trim();i.receipt={...(i.receipt||{}),source:i.receipt.source||'import',extracted:{...p,amount:finalAmount,date:finalDate,payerName:$('#rPayer').value.trim(),payerDoc:$('#rPayerDoc').value.trim(),receiverName:$('#rReceiver').value.trim(),receiverDoc:$('#rReceiverDoc').value.trim(),reference:$('#rReference').value.trim(),paymentMethod:$('#rMethod').value.trim(),transactionStatus:$('#rStatus').value.trim(),transactionId:$('#rTxId').value.trim(),property:$('#rProperty').value.trim(),note:i.note,confidence:p.confidence||0},validation:{status:'validated',validatedAt:new Date().toISOString(),validatedBy:role,issues,ocrMethod:parsed.method||'',ocrConfidence:parsed.confidence||0}};audit('VALIDOU_PAGAMENTO',`${i.label} · ${money(valorPrestacao)} (status ${i.status})${aplicarExcedente?` · comprovante ${money(finalAmount)}, excedente ${money(excedente)}`:''}`);saveState();const generated=buildSystemReceiptPDF(i);await storeGeneratedReceipt(i.id,generated);const originalBlob=await getStoredFile(i.receipt.blobId);if(originalBlob){try{const combined=await buildCombinedReceiptPDF(originalBlob,generated);await storeCombinedReceipt(i.id,combined);}catch(err){i.receipt.validation.combinedError=err.message;saveState();}}closeModal();renderPage(currentPage);if(ZMART_CONFIG.googleClientId||localStorage.getItem('zmart_google_client_id'))uploadReceiptToDrive(i.id).catch(console.warn);
      if(aplicarExcedente){ destinarExcedenteModal(i,excedente,finalDate,finalAmount); } else { showToast(i.status==='partial'?`Recebimento parcial registrado. Falta ${money(installmentBalance(i))}.`:'Pagamento validado e recibos gerados.'); }
    });
  }

  // Amortização de trás para frente (Cláusula 6ª), a partir de uma prestação inicial opcional:
  // aplica o valor sobre o SALDO real de cada prestação (suporta amortização parcial, não só
  // eliminação integral) e segue para trás (para a mais antiga) enquanto sobrar valor.
  function amortizeCascade(valor, obs='', startId=''){
    let restante=Number(valor)||0; const afetadas=[];
    const pendentes=state.installments.filter(i=>i.type==='parcela'&&i.status!=='paid').sort((a,b)=>b.dueDate.localeCompare(a.dueDate)); // da última para a primeira
    let lista=pendentes;
    if(startId){ const idx=pendentes.findIndex(p=>p.id===startId); if(idx>=0) lista=pendentes.slice(idx); }
    for(const parc of lista){
      if(restante<=0.01) break;
      const bal=installmentBalance(parc); if(bal<=0) continue;
      const aplicar=Math.min(bal,restante);
      applyPayment(parc,aplicar,today(),`Amortização antecipada (Cl. 6ª)${obs?` · ${obs}`:''}`);
      restante=Number((restante-aplicar).toFixed(2));
      afetadas.push({item:parc,aplicado:aplicar});
    }
    if(afetadas.length) audit('AMORTIZOU_ANTECIPADO',`${afetadas.length} parcela(s) · ${money(valor-restante)}`);
    return {afetadas, aplicado:Number((valor-restante).toFixed(2)), restante};
  }

  // Abate o excedente, de forma parcial e acumulativa, no saldo real da entrada — percorrendo as
  // parcelas de entrada em aberto na ordem do vencimento, sem nunca marcar uma como paga além do
  // que ela realmente recebeu.
  function applyExcedenteToEntrada(valor, obs, data){
    let restante=Number(valor)||0; const afetadas=[];
    const entradas=state.installments.filter(i=>i.type==='entrada'&&i.status!=='paid').sort((a,b)=>a.dueDate.localeCompare(b.dueDate));
    for(const e of entradas){
      if(restante<=0.01) break;
      const bal=installmentBalance(e); if(bal<=0) continue;
      const aplicar=Math.min(bal,restante);
      applyPayment(e,aplicar,data,obs);
      restante=Number((restante-aplicar).toFixed(2));
      afetadas.push({item:e,aplicado:aplicar});
    }
    if(afetadas.length) audit('EXCEDENTE_PARA_ENTRADA',`${money(valor-restante)} · ${afetadas.map(a=>a.item.label).join(', ')}`);
    return {afetadas, aplicado:Number((valor-restante).toFixed(2)), restante};
  }

  // Regra encadeada do excedente (comprovante de PRESTAÇÃO acima do saldo devido):
  // 1) Enquanto a entrada não estiver quitada, o excedente abate a entrada — parcial e acumulativo.
  // 2) Só depois da entrada quitada, o que sobrar vira multa (se em atraso) ou amortização de
  //    prestação futura, sugerida da última para a primeira (Cláusula 6ª). Sempre com confirmação.
  function destinarExcedenteModal(prestacao, excedente, data, comprovanteTotal){
    const entradaDebt=calc().entryDebt;
    if(entradaDebt>0.01){
      const valorSugerido=Math.min(excedente,entradaDebt);
      showModal('Excedente detectado no comprovante',`
        <div class="import-review-note"><b>O comprovante de ${esc(prestacao.label)} tem valor acima do saldo devido.</b><br>
        Comprovante: <b>${money(comprovanteTotal)}</b> · Prestação: <b>${money(prestacao.value)}</b> · Excedente: <b>${money(excedente)}</b>.<br>
        A prestação foi registrada normalmente. Enquanto a entrada não estiver quitada (saldo atual <b>${money(entradaDebt)}</b>), o excedente é oferecido primeiro para abatê-la — de forma parcial e acumulativa.</div>
        <form id="excEntradaForm" class="form-grid">
          <label class="field"><span>Valor a abater da entrada</span><input id="excEntradaValor" type="text" data-money inputmode="decimal" value="${formatMoneyBR(valorSugerido)}" required></label>
          <label class="field"><span>Data</span><input id="excEntradaData" type="text" data-date inputmode="numeric" value="${formatDateBRInput(data)}" placeholder="DD/MM/AAAA" maxlength="10" required></label>
          <label class="field wide"><span>Observações (correção manual, se o OCR falhou)</span><textarea id="excEntradaNote" rows="3" placeholder="Ex.: comprovante trouxe valor cheio; excedente destinado à entrada por acordo verbal."></textarea></label>
          <div class="validation-warning wide">Se sobrar excedente depois de abater a entrada, o sistema pergunta em seguida o destino do restante (multa ou amortização).</div>
          <div class="form-actions wide"><button type="button" class="text-link" id="excEntradaSkip">não abater a entrada agora</button><button class="primary-link green-button" type="submit">abater da entrada</button></div>
        </form>`);
      applyBRMasks($('#excEntradaForm'));
      $('#excEntradaSkip').addEventListener('click',()=>{closeModal();destinoRestanteModal(prestacao,excedente,data,comprovanteTotal);});
      $('#excEntradaForm').addEventListener('submit',e=>{e.preventDefault();
        const valor=readMoney($('#excEntradaValor')), dataMov=readDate($('#excEntradaData'))||data, obs=$('#excEntradaNote').value.trim();
        if(valor<=0){showToast('Informe um valor maior que zero.');return;}
        if(valor>excedente+0.01){showToast(`O excedente disponível é ${money(excedente)}.`);return;}
        if(!confirm(`Abater ${money(valor)} do excedente na entrada?`))return;
        const r=applyExcedenteToEntrada(valor,[`Coberto pelo excedente do comprovante de ${prestacao.label} (${money(comprovanteTotal)}).`,obs].filter(Boolean).join(' · '),dataMov);
        saveState();closeModal();renderPage(currentPage);
        const restanteExcedente=Number((excedente-r.aplicado).toFixed(2));
        showToast(`Excedente de ${money(r.aplicado)} abatido da entrada. Saldo da entrada: ${money(calc().entryDebt)}.`);
        if(restanteExcedente>0.01) destinoRestanteModal(prestacao,restanteExcedente,dataMov,comprovanteTotal);
      });
      return;
    }
    destinoRestanteModal(prestacao,excedente,data,comprovanteTotal);
  }

  // Passo 2 do excedente, só chega aqui quando a entrada já está quitada: multa (se em atraso)
  // ou amortização de prestação futura (sugerida da última para a primeira, Cláusula 6ª).
  function destinoRestanteModal(prestacao, valor, data, comprovanteTotal){
    const emAtraso = prestacao.dueDate < data;
    const pendentesDesc=state.installments.filter(i=>i.type==='parcela'&&i.status!=='paid').sort((a,b)=>b.dueDate.localeCompare(a.dueDate)); // da última para a primeira
    const optsParcela=pendentesDesc.map(p=>`<option value="${p.id}">${esc(p.label)} · saldo ${money(installmentBalance(p))} · vence ${dateBR(p.dueDate)}</option>`).join('');
    showModal('Entrada quitada — destino do excedente',`
      <div class="import-review-note"><b>A entrada está quitada.</b> Excedente de ${money(valor)} sobre ${esc(prestacao.label)} (comprovante ${money(comprovanteTotal)}). Escolha o destino, conforme a Cláusula 6ª.</div>
      <form id="excRestForm" class="form-grid">
        <label class="field wide"><span>Destino do excedente</span><select id="excRestDest">
          ${emAtraso?'<option value="multa">Registrar como multa por atraso</option>':''}
          <option value="amortizar" ${pendentesDesc.length?'':'disabled'}>Adiantar / amortizar prestação futura${pendentesDesc.length?'':' (nenhuma prestação pendente)'}</option>
          <option value="nada">Não movimentar agora</option>
        </select></label>
        <label class="field wide" id="excRestParcelaWrap" style="${pendentesDesc.length&&!emAtraso?'':'display:none'}"><span>Amortizar a partir de qual prestação</span><select id="excRestParcela">${optsParcela}</select><small class="helper">Sugestão: da última prestação para a primeira, reduzindo os juros futuros (Cl. 6ª). Se sobrar, o sistema continua nas anteriores.</small></label>
        <label class="field"><span>Valor a aplicar</span><input id="excRestValor" type="text" data-money inputmode="decimal" value="${formatMoneyBR(valor)}" required></label>
        <label class="field"><span>Data</span><input id="excRestData" type="text" data-date inputmode="numeric" value="${formatDateBRInput(data)}" placeholder="DD/MM/AAAA" maxlength="10" required></label>
        <label class="field wide"><span>Observações</span><textarea id="excRestNote" rows="3"></textarea></label>
        <div class="validation-warning wide">Confirme a movimentação. Nada é transferido sem esta confirmação.</div>
        <div class="form-actions wide"><button type="button" class="text-link" id="excRestCancel">agora não</button><button class="primary-link green-button" type="submit">confirmar destino</button></div>
      </form>`);
    applyBRMasks($('#excRestForm'));
    const destSel=$('#excRestDest'), wrap=$('#excRestParcelaWrap');
    const syncWrap=()=>{ wrap.style.display=(destSel.value==='amortizar'&&pendentesDesc.length)?'':'none'; };
    destSel.addEventListener('change',syncWrap); syncWrap();
    $('#excRestCancel').addEventListener('click',()=>{closeModal();showToast('Excedente não movimentado. A prestação foi validada normalmente.');});
    $('#excRestForm').addEventListener('submit',e=>{e.preventDefault();
      const dest=destSel.value, aplicar=readMoney($('#excRestValor')), dataMov=readDate($('#excRestData'))||data, obs=$('#excRestNote').value.trim();
      if(aplicar<=0){showToast('Informe um valor maior que zero.');return;}
      if(aplicar>valor+0.01){showToast(`O excedente disponível é ${money(valor)}.`);return;}
      if(dest==='multa'){
        if(!confirm(`Registrar ${money(aplicar)} como multa por atraso sobre ${prestacao.label}?`))return;
        prestacao.note=[prestacao.note,`Multa por atraso sobre o excedente: ${money(aplicar)} em ${dateBR(dataMov)}.`,obs].filter(Boolean).join(' · ');
        audit('EXCEDENTE_MULTA',`${money(aplicar)} · ${prestacao.label}`);
        saveState();closeModal();renderPage(currentPage);showToast(`Excedente de ${money(aplicar)} registrado como multa por atraso.`);
      } else if(dest==='amortizar'){
        const startId=$('#excRestParcela')?.value;
        if(!startId){showToast('Selecione a prestação inicial.');return;}
        const alvo=state.installments.find(x=>x.id===startId);
        if(!confirm(`Aplicar ${money(aplicar)} para amortizar prestações futuras a partir de ${alvo?.label||''} (Cl. 6ª)?`))return;
        const r=amortizeCascade(aplicar,obs,startId);
        saveState();closeModal();renderPage(currentPage);
        showToast(`${r.afetadas.length} prestação(ões) amortizada(s). Aplicado ${money(r.aplicado)}${r.restante>0.01?`, sobra ${money(r.restante)} não utilizada`:''}.`);
      } else {
        closeModal();showToast('Excedente não movimentado.');
      }
    });
  }

  // Concilia comprovantes soltos (sem lançamento identificado automaticamente) com um lançamento.
  function openReceiptInbox(){
    const inbox=state.receiptInbox||[]; if(!inbox.length){showToast('Não há comprovantes pendentes de conciliação.');return;}
    const options=state.installments.filter(i=>i.status!=='paid').sort((a,b)=>a.dueDate.localeCompare(b.dueDate)).map(i=>`<option value="${i.id}">${esc(i.label)} · ${money(i.value)} · ${dateBR(i.dueDate)}</option>`).join('');
    showModal('Conciliar comprovantes',`${inbox.map(x=>`<article class="inbox-item"><div><b>${esc(x.originalName)}</b><small>${formatBytes(x.size)} · ${x.parsed?.extracted?.amount?money(x.parsed.extracted.amount):'valor não lido'} · ${x.parsed?.extracted?.date?dateBR(x.parsed.extracted.date):'data não lida'}</small></div><div class="inbox-actions"><select data-inbox-target="${x.id}"><option value="">Selecione o lançamento</option>${options}</select><button class="text-link green-link" data-inbox-link="${x.id}">vincular</button></div></article>`).join('')}`);
    $$('[data-inbox-link]').forEach(btn=>btn.addEventListener('click',async()=>{const id=btn.dataset.inboxLink,target=$(`[data-inbox-target="${id}"]`)?.value;if(!target){showToast('Selecione um lançamento.');return;}const x=(state.receiptInbox||[]).find(y=>y.id===id),i=state.installments.find(y=>y.id===target);if(!x||!i)return;const blob=await getStoredFile(x.blobId);if(blob){const original=new File([blob],x.originalName||'comprovante', {type:x.type||blob.type||'application/octet-stream'});await saveOriginalReceipt(original,i.id,x.parsed);}state.receiptInbox=state.receiptInbox.filter(y=>y.id!==id);await deleteStoredFile(x.blobId).catch(()=>{});saveState();closeModal();reviewAndValidateModal(i.id,x.parsed,x.parsed?.extracted?.amount||i.value,x.parsed?.extracted?.date||today(),'');}));
  }

  function parseBRMoney(v){
    // Aceita "R$ 1.000,50", "1.000,50", "1000,50", "1000.50" e "1000".
    let s=String(v??'').replace(/[R$\s]/gi,'').trim();
    if(!s) return 0;
    if(s.includes(',')){ s=s.replace(/\./g,'').replace(',','.'); } // formato BR: ponto = milhar, vírgula = decimal
    // sem vírgula: mantém como está (ponto tratado como decimal, ex.: "1000.50")
    return Number(s)||0;
  }
  function formatMoneyBR(v){return new Intl.NumberFormat('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(v)||0);}
  // Máscara de digitação cursiva: enquanto o usuário digita, formata como 0.000,00 automaticamente.
  function maskMoneyLive(el){
    const digits=String(el.value||'').replace(/\D/g,'');
    if(!digits){el.value='';return;}
    const num=Number(digits)/100;
    el.value=formatMoneyBR(num);
  }
  function readMoney(el){return el?parseBRMoney(el.value):0;}
  function parseBRDate(v){
    // Aceita "DD/MM/AAAA", "DD-MM-AAAA" e ISO "AAAA-MM-DD"; retorna ISO ou ''.
    const s=String(v??'').trim(); if(!s) return '';
    let m=s.match(/^(\d{4})-(\d{2})-(\d{2})$/); if(m) return `${m[1]}-${m[2]}-${m[3]}`;
    m=s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if(m){let[,d,mo,y]=m; if(y.length===2)y='20'+y; d=d.padStart(2,'0'); mo=mo.padStart(2,'0'); return `${y}-${mo}-${d}`;}
    return '';
  }
  function formatDateBRInput(iso){const s=String(iso||''); const m=s.match(/^(\d{4})-(\d{2})-(\d{2})$/); return m?`${m[3]}/${m[2]}/${m[1]}`:'';}
  function maskDateLive(el){
    let d=String(el.value||'').replace(/\D/g,'').slice(0,8);
    let out=d;
    if(d.length>4) out=`${d.slice(0,2)}/${d.slice(2,4)}/${d.slice(4)}`;
    else if(d.length>2) out=`${d.slice(0,2)}/${d.slice(2)}`;
    el.value=out;
  }
  function readDate(el){return el?parseBRDate(el.value):'';}
  // Aplica máscaras a inputs marcados com data-money / data-date dentro de um container.
  function applyBRMasks(root=document){
    $$('input[data-money]',root).forEach(el=>{
      if(el.dataset.brBound) return; el.dataset.brBound='1';
      el.setAttribute('inputmode','decimal'); el.setAttribute('autocomplete','off');
      if(el.value!=='' && !isNaN(Number(el.value))) el.value=formatMoneyBR(el.value); // converte valor inicial numérico
      el.addEventListener('input',()=>maskMoneyLive(el));
      el.addEventListener('blur',()=>{ if(el.value!=='') el.value=formatMoneyBR(parseBRMoney(el.value)); });
    });
    $$('input[data-date]',root).forEach(el=>{
      if(el.dataset.brBound) return; el.dataset.brBound='1';
      el.setAttribute('inputmode','numeric'); el.setAttribute('autocomplete','off'); el.setAttribute('placeholder','DD/MM/AAAA'); el.setAttribute('maxlength','10');
      if(/^\d{4}-\d{2}-\d{2}$/.test(el.value)) el.value=formatDateBRInput(el.value); // converte ISO inicial
      el.addEventListener('input',()=>maskDateLive(el));
    });
  }
  async function loadPdfJs(){if(window.pdfjsLib)return;await new Promise((resolve,reject)=>{const sc=document.createElement('script');sc.src='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';sc.onload=resolve;sc.onerror=()=>reject(new Error('Leitor PDF não disponível. Na primeira utilização do OCR é necessária internet para carregar o módulo. Depois, o navegador poderá reutilizá-lo em cache.'));document.head.appendChild(sc);});}
  async function loadTesseract(){if(window.Tesseract)return;await new Promise((resolve,reject)=>{const sc=document.createElement('script');sc.src='https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';sc.onload=resolve;sc.onerror=()=>reject(new Error('OCR não disponível. Na primeira utilização é necessária internet para carregar o motor e o idioma português.'));document.head.appendChild(sc);});}

  const DB_NAME='zmart_lar_plus_files_v1',DB_STORE='files';
  function openFileDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open(DB_NAME,1);r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains(DB_STORE))r.result.createObjectStore(DB_STORE);};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
  async function idbPut(id,blob){const db=await openFileDB();return new Promise((resolve,reject)=>{const tx=db.transaction(DB_STORE,'readwrite');tx.objectStore(DB_STORE).put(blob,id);tx.oncomplete=()=>{db.close();resolve(id)};tx.onerror=()=>{db.close();reject(tx.error)}})}
  async function idbGet(id){if(!id)return null;const db=await openFileDB();return new Promise((resolve,reject)=>{const tx=db.transaction(DB_STORE,'readonly');const q=tx.objectStore(DB_STORE).get(id);q.onsuccess=()=>{db.close();resolve(q.result||null)};q.onerror=()=>{db.close();reject(q.error)}})}
  async function idbDelete(id){if(!id)return;const db=await openFileDB();return new Promise((resolve,reject)=>{const tx=db.transaction(DB_STORE,'readwrite');tx.objectStore(DB_STORE).delete(id);tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>{db.close();reject(tx.error)}})}
  // Comprovantes (arquivos): o IndexedDB local funciona sempre como cache — leitura instantânea,
  // funciona offline. Quando a nuvem está configurada, cada arquivo TAMBÉM é enviado ao Supabase
  // Storage (bucket "receipts"), para que a outra pessoa (que nunca teve esse arquivo no próprio
  // aparelho) consiga baixá-lo ao abrir o app pela primeira vez.
  async function putStoredFile(id,blob){
    await idbPut(id,blob);
    if(supabaseConfigured()){
      fetch(`${window.ZMART_CONFIG.supabaseUrl.replace(/\/$/,'')}/storage/v1/object/receipts/${encodeURIComponent(id)}`,
        {method:'PUT',headers:sbHeaders({'Content-Type':blob.type||'application/octet-stream','x-upsert':'true'}),body:blob})
        .catch(err=>console.warn('Falha ao enviar comprovante para a nuvem:',err.message));
    }
    return id;
  }
  async function getStoredFile(id){
    if(!id)return null;
    const local=await idbGet(id);
    if(local) return local;
    if(supabaseConfigured()){
      try{
        const res=await fetch(`${window.ZMART_CONFIG.supabaseUrl.replace(/\/$/,'')}/storage/v1/object/receipts/${encodeURIComponent(id)}`,{headers:sbHeaders()});
        if(res.ok){ const blob=await res.blob(); idbPut(id,blob).catch(()=>{}); return blob; }
      }catch(err){ console.warn('Falha ao buscar comprovante da nuvem:',err.message); }
    }
    return null;
  }
  async function deleteStoredFile(id){
    await idbDelete(id);
    if(supabaseConfigured()){
      fetch(`${window.ZMART_CONFIG.supabaseUrl.replace(/\/$/,'')}/storage/v1/object/receipts/${encodeURIComponent(id)}`,{method:'DELETE',headers:sbHeaders()})
        .catch(err=>console.warn('Falha ao excluir comprovante na nuvem:',err.message));
    }
  }
  // blobKey identifica o ARQUIVO no storage (único por pagamento, nunca sobrescreve outro comprovante).
  // itemId identifica o LANÇAMENTO cujo campo "receipt" (snapshot mais recente) será atualizado.
  // Retorna as referências do comprovante para quem chamou anexar a um pagamento específico do histórico.
  async function saveOriginalReceiptFor(file,itemId,blobKey,parsed=null){
    const blobId='file_'+blobKey; await putStoredFile(blobId,file);
    const i=state.installments.find(x=>x.id===itemId);
    const receiptRef={blobId,originalName:file.name,name:file.name,size:file.size,type:file.type,createdAt:new Date().toISOString()};
    if(i){ i.receipt={...(i.receipt||{}),...receiptRef,source:parsed?.method||'upload',extracted:parsed?.extracted||i.receipt?.extracted||null,rawText:parsed?.text||i.receipt?.rawText||''}; saveState(); }
    return receiptRef;
  }
  async function saveOriginalReceipt(file,id,parsed=null){await saveOriginalReceiptFor(file,id,id,parsed);return parsed||{};}
  async function storeGeneratedReceipt(id,blob){const i=state.installments.find(x=>x.id===id);if(!i)return;const blobId='generated_'+id;await putStoredFile(blobId,blob);i.receipt={...(i.receipt||{}),generatedBlobId:blobId,generatedName:`ZMART-Lar+-Recibo-${i.number||id}.pdf`,generatedAt:new Date().toISOString()};saveState();}
  async function storeCombinedReceipt(id,blob){const i=state.installments.find(x=>x.id===id);if(!i)return;const blobId='combined_'+id;await putStoredFile(blobId,blob);i.receipt={...(i.receipt||{}),combinedBlobId:blobId,combinedName:`ZMART-Lar+-Comprovante-Completo-${i.number||id}.pdf`,combinedAt:new Date().toISOString()};saveState();}
  async function loadPdfLib(){if(window.PDFLib)return;await new Promise((resolve,reject)=>{const sc=document.createElement('script');sc.src='https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';sc.onload=resolve;sc.onerror=()=>reject(new Error('Composição do comprovante completo indisponível.'));document.head.appendChild(sc);});}
  async function buildCombinedReceiptPDF(originalBlob,generatedBlob){
    await loadPdfLib(); const {PDFDocument,rgb}=window.PDFLib; const out=await PDFDocument.create();
    if(originalBlob.type==='application/pdf'||originalBlob.name?.toLowerCase().endsWith('.pdf')){const orig=await PDFDocument.load(await originalBlob.arrayBuffer());const op=await out.copyPages(orig,orig.getPageIndices());op.forEach(pg=>out.addPage(pg));}
    else {let img; if(/png/i.test(originalBlob.type)||/\.png$/i.test(originalBlob.name||'')) img=await out.embedPng(await originalBlob.arrayBuffer()); else img=await out.embedJpg(await originalBlob.arrayBuffer()); const ratio=img.width/img.height;const pageW=595,pageH=Math.max(842,pageW/ratio);const pg=out.addPage([pageW,pageH]);pg.drawImage(img,{x:0,y:0,width:pageW,height:pageW/ratio});}
    const gen=await PDFDocument.load(await generatedBlob.arrayBuffer());const gp=await out.copyPages(gen,gen.getPageIndices());gp.forEach(pg=>out.addPage(pg));return new Blob([await out.save()],{type:'application/pdf'});
  }
  function downloadBlob(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.target='_blank';a.click();setTimeout(()=>URL.revokeObjectURL(url),1500)}
  async function deleteInstallmentAndReceipt(id){const i=state.installments.find(x=>x.id===id);if(i?.receipt){await deleteStoredFile(i.receipt.blobId).catch(()=>{});await deleteStoredFile(i.receipt.generatedBlobId).catch(()=>{});await deleteStoredFile(i.receipt.combinedBlobId).catch(()=>{});}state.installments=state.installments.filter(x=>x.id!==id);saveState();}

  function buildSystemReceiptPDF(i){const e=i.receipt?.extracted||{};const lines=['RECIBO DE PAGAMENTO','ZMART Lar+','',`Recibo referente a: ${i.label}`,`Valor recebido: ${money(i.paidValue||i.value)}`,`Data do recebimento: ${dateBR(i.paidAt)}`,`Pagador: ${e.payerName||'Não informado'}`,`CPF/CNPJ do pagador: ${e.payerDoc||'Não informado'}`,`Recebedor: ${e.receiverName||'Não informado'}`,`CPF/CNPJ do recebedor: ${e.receiverDoc||'Não informado'}`,`Imóvel/contrato: ${e.property||state.property.title}`,`Referência: ${e.reference||i.label}`,`Forma de pagamento: ${e.paymentMethod||'Não informado'}`,`Situação da transação: ${e.transactionStatus||'Não informado'}`,`ID da transação: ${e.transactionId||'Não informado'}`,`Código da operação: ${e.operationCode||'Não informado'}`,`Chave de segurança: ${e.securityKey||'Não informado'}`,`Chave Pix: ${e.pixKey||'Não informado'}`,'',`Observações: ${e.note||i.note||'—'}`,'',`Documento original: ${i.receipt?.originalName||'—'}`,`Validação: CONFIRMADA por ${i.receipt?.validation?.validatedBy||role||'ADM'}`,`Gerado em: ${new Date().toLocaleString('pt-BR')}`];return buildPDF(lines)}

  async function deleteInstallment(id){if(role!=='vendedor')return;const i=state.installments.find(x=>x.id===id);if(!i)return;if(i.type==='entrada'){showToast('A entrada não pode ser excluída aqui: ela é definida pelo valor cadastrado na venda. Para removê-la, edite a venda e zere o valor da entrada.');return;}if(confirm(`Excluir ${i.label}?`)){await deleteInstallmentAndReceipt(id);audit('EXCLUIU_LANCAMENTO',i.label);saveState();renderPage(currentPage);showToast('Lançamento excluído.');}}

  function historiesByMonth(){
    // Group installments by year-month, tracking entry vs parcel separately.
    // IMPORTANT: usa o valor efetivamente recebido (i.received), não só os lançamentos com
    // status "paid" — assim um pagamento PARCIAL (ex.: entrada com R$3.000 de R$10.000) também
    // entra no acumulado do gráfico, em vez de ficar de fora até ser quitado 100%.
    const monthly={};
    const ordered=[...state.installments].sort((a,b)=>a.dueDate.localeCompare(b.dueDate));
    ordered.forEach(i=>{
      const ym=(i.dueDate||'').slice(0,7); // "YYYY-MM"
      if(!monthly[ym]) monthly[ym]={ym,entryPaid:0,parcelPaid:0,total:0};
      const v=Number(i.received||0);
      if(v>0){
        monthly[ym].total+=v;
        if(i.type==='entrada') monthly[ym].entryPaid+=v;
        else monthly[ym].parcelPaid+=v;
      }
    });
    const keys=Object.keys(monthly).sort();
    let cumEntry=0,cumParcel=0;
    return keys.map(k=>{
      cumEntry+=monthly[k].entryPaid;
      cumParcel+=monthly[k].parcelPaid;
      return {ym:k, label:formatYM(k), cumEntry, cumParcel, cumTotal:cumEntry+cumParcel, debt:Math.max(0,state.property.total-(cumEntry+cumParcel))};
    });
  }
  function formatYM(ym){
    const months=['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    const [y,m]=ym.split('-');
    return months[parseInt(m,10)-1]+' '+y.slice(2);
  }
  function drawDashboardCharts(){drawPie3Seg();drawCombinedLine();}
  function drawPie3Seg(){
    const svg=$('#pieChart'); if(!svg)return;
    const c=calc();
    const cx=110,cy=110,r=78,ri=50;
    const total=Math.max(1,c.entryPaid+c.parcelPaid+c.debt);
    const segs=[
      {val:c.entryPaid, color:'#b8944e'},
      {val:c.parcelPaid, color:'#3d8f66'},
      {val:c.debt, color:'#c8d0db'}
    ];
    let startAngle=-Math.PI/2;
    let paths='';
    segs.forEach(seg=>{
      const pct=seg.val/total;
      if(pct<=0)return;
      const angle=pct*Math.PI*2;
      const endAngle=startAngle+angle;
      const large=angle>Math.PI?1:0;
      const x1=cx+r*Math.cos(startAngle), y1=cy+r*Math.sin(startAngle);
      const x2=cx+r*Math.cos(endAngle),   y2=cy+r*Math.sin(endAngle);
      const xi1=cx+ri*Math.cos(startAngle),yi1=cy+ri*Math.sin(startAngle);
      const xi2=cx+ri*Math.cos(endAngle),  yi2=cy+ri*Math.sin(endAngle);
      paths+=`<path d="M ${xi1.toFixed(1)} ${yi1.toFixed(1)} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} L ${xi2.toFixed(1)} ${yi2.toFixed(1)} A ${ri} ${ri} 0 ${large} 0 ${xi1.toFixed(1)} ${yi1.toFixed(1)} Z" fill="${seg.color}"/>`;
      startAngle=endAngle;
    });
    const pctTxt=c.paidPct.toFixed(1)+'%';
    svg.innerHTML=`<circle cx="110" cy="110" r="78" fill="#eef0f4"/>${paths}<circle cx="110" cy="110" r="50" fill="#fffdf9"/><text x="110" y="104" text-anchor="middle" font-size="19" font-weight="800" fill="#162036">${pctTxt}</text><text x="110" y="122" text-anchor="middle" font-size="10" fill="#707987">quitado</text>`;
  }
  function drawCombinedLine(){
    const svg=$('#lineChart'); if(!svg)return;
    const months=historiesByMonth();
    const wrap=svg.closest('.wide-chart');
    let tip=wrap?wrap.querySelector('.chart-tooltip'):null;
    if(wrap&&!tip){tip=document.createElement('div');tip.className='chart-tooltip';wrap.appendChild(tip);}
    if(!months.length){svg.innerHTML='<text x="400" y="150" text-anchor="middle" font-size="13" fill="#9aa0ab">Nenhum pagamento registrado ainda.</text>';if(tip)tip.classList.remove('show');return;}
    const W=800,H=300,pl=56,pr=18,pt=24,pb=44;
    const iw=W-pl-pr, ih=H-pt-pb;
    const maxVal=Math.max(state.property.total,1);
    const nMonths=months.length;
    const xs=i=>pl+(nMonths<=1?iw/2:iw*i/(nMonths-1));
    const ys=v=>pt+ih-(v/maxVal)*ih;
    // Y grid lines with labels
    const yTicks=[0,0.25,0.5,0.75,1.0];
    const gridLines=yTicks.map(t=>{
      const y=(pt+ih-t*ih).toFixed(1);
      const lbl=money(t*maxVal).replace('R$\u00a0','R$ ');
      return `<line x1="${pl}" y1="${y}" x2="${W-pr}" y2="${y}" stroke="#ece7df" stroke-width="1"/>` +
             `<text x="${pl-5}" y="${parseFloat(y)+4}" text-anchor="end" font-size="9" fill="#a0a8b5">${money(t*maxVal)}</text>`;
    }).join('');
    // Entry path (gold)
    const entryPts=months.map((m,i)=>[xs(i),ys(m.cumEntry)]);
    const entryD=entryPts.map((p,i)=>(i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1)).join(' ');
    const entryArea=entryD+` L ${entryPts.at(-1)[0].toFixed(1)} ${H-pb} L ${entryPts[0][0].toFixed(1)} ${H-pb} Z`;
    // Parcel path (green, stacked on entry)
    const totalPts=months.map((m,i)=>[xs(i),ys(m.cumTotal)]);
    const totalD=totalPts.map((p,i)=>(i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1)).join(' ');
    // Parcel fill between total and entry
    const parcelAreaD=totalD+' '+[...entryPts].reverse().map((p,i)=>(i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1)).join(' ')+' Z';
    // Debt path (dashed navy)
    const debtPts=months.map((m,i)=>[xs(i),ys(m.debt)]);
    const debtD=debtPts.map((p,i)=>(i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1)).join(' ');
    // X-axis labels (show up to ~8 evenly spaced)
    const step=Math.max(1,Math.ceil(nMonths/8));
    const xLabels=months.map((m,i)=>{
      if(i%step!==0&&i!==nMonths-1)return '';
      return `<text x="${xs(i).toFixed(1)}" y="${H-pb+14}" text-anchor="middle" font-size="9" fill="#a0a8b5">${m.label}</text>`;
    }).join('');
    // Dots only on last point
    const lastEntry=entryPts.at(-1);
    const lastTotal=totalPts.at(-1);
    const dots=`<circle cx="${lastEntry[0].toFixed(1)}" cy="${lastEntry[1].toFixed(1)}" r="5" fill="#b8944e"/>` +
                `<circle cx="${lastTotal[0].toFixed(1)}" cy="${lastTotal[1].toFixed(1)}" r="5" fill="#3d8f66"/>`;
    const cursorGroup=`<g id="lineCursor" style="display:none;pointer-events:none">
      <line id="lineCursorLine" x1="0" y1="${pt}" x2="0" y2="${H-pb}" stroke="#8b93a3" stroke-width="1" stroke-dasharray="3 3"/>
      <circle id="lineCursorEntry" r="4.5" fill="#b8944e" stroke="#fff" stroke-width="1.5"/>
      <circle id="lineCursorTotal" r="4.5" fill="#3d8f66" stroke="#fff" stroke-width="1.5"/>
      <circle id="lineCursorDebt" r="4.5" fill="#8fa3c0" stroke="#fff" stroke-width="1.5"/>
    </g>`;
    svg.innerHTML=`${gridLines}<path d="${entryArea}" fill="rgba(184,148,78,.18)"/><path d="${parcelAreaD}" fill="rgba(61,143,102,.15)"/><path d="${entryD}" fill="none" stroke="#b8944e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><path d="${totalD}" fill="none" stroke="#3d8f66" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><path d="${debtD}" fill="none" stroke="#8fa3c0" stroke-width="1.8" stroke-dasharray="5 4" stroke-linecap="round" stroke-linejoin="round"/>${dots}${xLabels}<line x1="${pl}" y1="${pt}" x2="${pl}" y2="${H-pb}" stroke="#ddd8d0" stroke-width="1"/><line x1="${pl}" y1="${H-pb}" x2="${W-pr}" y2="${H-pb}" stroke="#ddd8d0" stroke-width="1"/>${cursorGroup}<rect id="lineHoverArea" x="${pl}" y="${pt}" width="${iw}" height="${ih}" fill="transparent" pointer-events="all" style="cursor:crosshair"/>`;

    // Interactive hover: shows date + values as the user moves the cursor (mouse or touch)
    const cursor=svg.querySelector('#lineCursor');
    const cursorLine=svg.querySelector('#lineCursorLine');
    const cEntry=svg.querySelector('#lineCursorEntry');
    const cTotal=svg.querySelector('#lineCursorTotal');
    const cDebt=svg.querySelector('#lineCursorDebt');
    const hoverArea=svg.querySelector('#lineHoverArea');

    function showAt(clientX){
      const svgRect=svg.getBoundingClientRect();
      if(!svgRect.width)return;
      const relX=(clientX-svgRect.left)/svgRect.width*W;
      let idx=0,best=Infinity;
      months.forEach((m,i)=>{const d=Math.abs(xs(i)-relX);if(d<best){best=d;idx=i;}});
      const m=months[idx];
      const x=xs(idx);
      cursorLine.setAttribute('x1',x.toFixed(1));cursorLine.setAttribute('x2',x.toFixed(1));
      cEntry.setAttribute('cx',x.toFixed(1));cEntry.setAttribute('cy',ys(m.cumEntry).toFixed(1));
      cTotal.setAttribute('cx',x.toFixed(1));cTotal.setAttribute('cy',ys(m.cumTotal).toFixed(1));
      cDebt.setAttribute('cx',x.toFixed(1));cDebt.setAttribute('cy',ys(m.debt).toFixed(1));
      cursor.style.display='block';
      if(tip&&wrap){
        tip.innerHTML=`<strong>${m.label}</strong><span><i class="dot gold-dot"></i>Entrada acum. <b>${money(m.cumEntry)}</b></span><span><i class="dot green-dot"></i>Parcelas acum. <b>${money(m.cumParcel)}</b></span><span><i class="dot navy-dot-light"></i>Saldo devedor <b>${money(m.debt)}</b></span>`;
        tip.classList.add('show');
        const wrapRect=wrap.getBoundingClientRect();
        let pxX=svgRect.left-wrapRect.left+(x/W)*svgRect.width;
        let pxY=svgRect.top-wrapRect.top+(ys(m.debt)/H)*svgRect.height;
        const tw=tip.offsetWidth,th=tip.offsetHeight;
        pxX=Math.min(Math.max(pxX-tw/2,6),Math.max(6,wrapRect.width-tw-6));
        pxY=Math.max(pxY-th-16,6);
        tip.style.left=pxX+'px';
        tip.style.top=pxY+'px';
      }
    }
    function hide(){cursor.style.display='none';if(tip)tip.classList.remove('show');}

    hoverArea.onmousemove=e=>showAt(e.clientX);
    hoverArea.onmouseleave=hide;
    hoverArea.ontouchstart=e=>{if(e.touches[0])showAt(e.touches[0].clientX);};
    hoverArea.ontouchmove=e=>{if(e.touches[0]){showAt(e.touches[0].clientX);e.preventDefault();}};
    hoverArea.ontouchend=hide;
  }


  function makePDF(kind){
    const c=calc();let list=kind==='paid'?state.installments.filter(i=>i.status==='paid'):kind==='schedule'?state.installments.filter(i=>i.status!=='paid'):kind==='receipts'?state.installments.filter(i=>i.receipt):state.installments;const title=kind==='paid'?'Extrato de pagamentos':kind==='schedule'?'Agenda financeira':kind==='buyer'?'Resumo do comprador':kind==='receipts'?'Dossiê de comprovantes':'Relatório financeiro completo';const lines=[title,'ZMART Lar+','Do compromisso à realização.','',`Venda: ${state.property.title}`,`Valor do imóvel: ${money(state.property.total)}`,`Total pago: ${money(c.paid)}`,`Saldo devedor: ${money(c.debt)}`,`Progresso: ${c.paidPct.toFixed(1)}%`,'','LANÇAMENTOS'];list.forEach(i=>{lines.push(`${i.label} | ${dateBR(i.dueDate)} | ${money(i.status==='paid'?i.paidValue:i.value)} | ${i.status==='paid'?'PAGO':'PENDENTE'}`);if(kind==='receipts'){const r=i.receipt||{};const e=r.extracted||{};lines.push(`  Original: ${r.originalName||'—'} | ${formatBytes(r.size)}`);lines.push(`  Transação: ${e.transactionId||'—'} | Situação: ${e.transactionStatus||'—'} | OCR: ${r.validation?.ocrMethod||'—'}`);lines.push(`  Validação: ${r.validation?.status||'—'} | Drive: ${r.driveFileId?'SIM':'NÃO'}`);}});lines.push('',`REGRAS DA VENDA`,`Entrada: ${money(state.property.entryTotal)} em ${state.schedule?.entryCount||0} parcela(s)`,`Parcelas: ${state.schedule?.parcelCount||0} · Dia limite: ${state.schedule?.paymentDayLimit||'—'}`,`Juros por atraso: ${Number(state.schedule?.lateInterestRate||0).toLocaleString('pt-BR')}% ${state.schedule?.lateInterestPeriod==='daily'?'ao dia':'ao mês'}`);(state.schedule?.annualPlans||[]).forEach(r=>lines.push(`Ano ${r.year}: ${r.count} × ${money(r.value)} = ${money(Number(r.count||0)*Number(r.value||0))}`));lines.push('',`Gerado em ${new Date().toLocaleString('pt-BR')}`);const blob=buildPDF(lines);const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`ZMART-Lar+-${kind}-${today()}.pdf`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1200);showToast('PDF gerado.');}
  function pdfEsc(s){return String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)');}
  function buildPDF(lines){
    const width=595,height=842,margin=40,leading=15,maxChars=92; const wrapped=[]; lines.forEach(line=>{let t=String(line??'');if(!t){wrapped.push('');return;}while(t.length>maxChars){let cut=t.lastIndexOf(' ',maxChars);if(cut<20)cut=maxChars;wrapped.push(t.slice(0,cut));t=t.slice(cut).trim();}wrapped.push(t);});
    const perPage=48,pages=Math.max(1,Math.ceil(wrapped.length/perPage)),objs=[],pageRefs=[],contentRefs=[]; let objNo=1;
    objs[objNo]='<< /Type /Catalog /Pages 2 0 R >>';objNo++;objs[objNo]=`<< /Type /Pages /Kids [${Array.from({length:pages},(_,k)=>3+k*2).map(n=>n+' 0 R').join(' ')}] /Count ${pages} >>`;objNo=3;
    for(let p=0;p<pages;p++){const pageObj=3+p*2,contentObj=4+p*2;pageRefs.push(pageObj);contentRefs.push(contentObj);let y=height-42;const pageLines=wrapped.slice(p*perPage,(p+1)*perPage);let content='BT\n/F1 9 Tf\n';pageLines.forEach((line,idx)=>{if(idx===0&&p===0)content+=`/F1 15 Tf\n1 0 0 1 ${margin} ${y} Tm\n(${pdfEsc(line)}) Tj\n`;else{y-=leading;content+=`/F1 9 Tf\n1 0 0 1 ${margin} ${y} Tm\n(${pdfEsc(line)}) Tj\n`;}});content+=`/F1 7 Tf\n1 0 0 1 ${margin} 22 Tm\n(Pagina ${p+1} de ${pages} · ZMART Lar+) Tj\nET`;objs[pageObj]=`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 ${3+pages*2} 0 R >> >> /Contents ${contentObj} 0 R >>`;objs[contentObj]=`<< /Length ${content.length} >>\nstream\n${content}\nendstream`;}
    const fontObj=3+pages*2;objs[fontObj]='<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';let pdf='%PDF-1.4\n',offsets=[0];for(let i=1;i<=fontObj;i++){offsets[i]=pdf.length;pdf+=`${i} 0 obj\n${objs[i]}\nendobj\n`;}const xref=pdf.length;pdf+=`xref\n0 ${fontObj+1}\n0000000000 65535 f \n`;for(let i=1;i<=fontObj;i++)pdf+=`${String(offsets[i]).padStart(10,'0')} 00000 n \n`;pdf+=`trailer\n<< /Size ${fontObj+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;return new Blob([pdf],{type:'application/pdf'});
  }
  async function blobToBase64(blob){const buf=await blob.arrayBuffer();let binary='';const bytes=new Uint8Array(buf);const chunk=0x8000;for(let i=0;i<bytes.length;i+=chunk)binary+=String.fromCharCode(...bytes.subarray(i,i+chunk));return btoa(binary);}
  function base64ToBlob(data,type){const binary=atob(data);const bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);return new Blob([bytes],{type:type||'application/octet-stream'});}
  async function collectBackupFileIds(){
    const ids=new Map();
    for(const sale of (state.sales||[])){
      for(const i of (sale.installments||[])){
        for(const k of ['blobId','generatedBlobId','combinedBlobId']) if(i.receipt?.[k]) ids.set(i.receipt[k],i.receipt);
      }
      for(const x of (sale.receiptInbox||[])) if(x.blobId) ids.set(x.blobId,x);
    }
    return ids;
  }
  async function exportBackup(){
    try{const ids=await collectBackupFileIds();const files=[];for(const [id,meta] of ids){const blob=await getStoredFile(id);if(blob)files.push({id,name:meta.originalName||meta.generatedName||meta.combinedName||id,type:blob.type||meta.type||'application/octet-stream',size:blob.size,data:await blobToBase64(blob)});}const payload={app:'ZMART Lar+',version:STATE_VERSION,exportedAt:new Date().toISOString(),state,files};const blob=new Blob([JSON.stringify(payload)],{type:'application/json'});downloadBlob(blob,`ZMART-Lar+-backup-${today()}.json`);showToast(`Backup completo exportado: ${(state.sales||[]).length} venda(s), ${files.length} documento(s).`);}
    catch(e){console.error(e);showToast('Não foi possível gerar o backup completo.');}
  }
  async function importBackup(file){if(!file)return;try{const obj=JSON.parse(await file.text());const incoming=normalizeState(obj.state);if(!incoming?.sales?.length)throw new Error('Backup inválido');if(!confirm(`Restaurar backup com ${incoming.sales.length} venda(s) e substituir os dados atuais?`))return;for(const f of (obj.files||[])){if(f?.id&&f.data)await putStoredFile(f.id,base64ToBlob(f.data,f.type));}state=incoming;activateSale(state.activeSaleId);audit('RESTAURou_BACKUP',`${obj.files?.length||0} documento(s) · ${state.sales.length} venda(s)`);saveState();currentPage='dashboard';render();showToast('Backup completo restaurado.');}catch(e){console.error(e);showToast(e.message||'Não foi possível restaurar o backup.');}}
  let driveTokenClient=null;let driveAccessToken=null;
  async function loadGoogleIdentity(){if(window.google?.accounts?.oauth2)return;await new Promise((resolve,reject)=>{const sc=document.createElement('script');sc.src='https://accounts.google.com/gsi/client';sc.onload=resolve;sc.onerror=()=>reject(new Error('Não foi possível carregar o Google Identity Services.'));document.head.appendChild(sc);});}
  async function connectGoogleDrive(){const clientId=localStorage.getItem('zmart_google_client_id')||ZMART_CONFIG.googleClientId||'';if(!clientId){showToast('Informe primeiro o Google Client ID.');return false;}try{await loadGoogleIdentity();return await new Promise((resolve,reject)=>{driveTokenClient=google.accounts.oauth2.initTokenClient({client_id:clientId,scope:'https://www.googleapis.com/auth/drive.file',callback:async resp=>{if(resp.error){reject(new Error(resp.error));return;}driveAccessToken=resp.access_token;localStorage.setItem('zmart_drive_connected','1');showToast('Google Drive conectado.');resolve(true);}});driveTokenClient.requestAccessToken({prompt:'consent'});});}catch(e){console.error(e);showToast('Não foi possível conectar ao Google Drive.');return false;}}
  async function ensureDriveToken(){if(driveAccessToken)return driveAccessToken;const ok=await connectGoogleDrive();if(!ok)throw new Error('Google Drive não conectado');return driveAccessToken;}
  async function ensureDriveFolder(){const token=await ensureDriveToken();const q=encodeURIComponent("name='ZMART Lar+' and mimeType='application/vnd.google-apps.folder' and trashed=false");const r=await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=10`,{headers:{Authorization:'Bearer '+token}});if(!r.ok)throw new Error('Não foi possível localizar a pasta do ZMART.');const data=await r.json();if(data.files?.[0]?.id)return data.files[0].id;const c=await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({name:'ZMART Lar+',mimeType:'application/vnd.google-apps.folder'})});if(!c.ok)throw new Error('Não foi possível criar a pasta do ZMART no Drive.');return (await c.json()).id;}
  async function driveUpload(blob,name,mime,parentId){const token=await ensureDriveToken();const boundary='zmart_'+Math.random().toString(16).slice(2);const meta={name,mimeType:mime,parents:parentId?[parentId]:[]};const body=new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,JSON.stringify(meta),`\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,blob,`\r\n--${boundary}--`]);const r=await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'multipart/related; boundary='+boundary},body});if(!r.ok)throw new Error('Falha no envio para o Google Drive.');return r.json();}
  async function uploadReceiptToDrive(id){if(role!=='vendedor')return;const i=state.installments.find(x=>x.id===id);if(!i?.receipt)return;try{showToast('Preparando envio ao Google Drive…');const folder=await ensureDriveFolder();const original=await getStoredFile(i.receipt.blobId);if(original&&!i.receipt.driveFileId){const f=await driveUpload(original,i.receipt.originalName||i.receipt.name||`recibo-${i.number||id}.pdf`,i.receipt.type||'application/pdf',folder);i.receipt.driveFileId=f.id;i.receipt.driveUrl=f.webViewLink||'';}const generated=await getStoredFile(i.receipt.generatedBlobId);if(generated&&!i.receipt.generatedDriveFileId){const f2=await driveUpload(generated,i.receipt.generatedName||`ZMART-Lar+-Recibo-${i.number||id}.pdf`,'application/pdf',folder);i.receipt.generatedDriveFileId=f2.id;i.receipt.generatedDriveUrl=f2.webViewLink||'';}const combined=await getStoredFile(i.receipt.combinedBlobId);if(combined&&!i.receipt.combinedDriveFileId){const f3=await driveUpload(combined,i.receipt.combinedName||`ZMART-Lar+-Comprovante-Completo-${i.number||id}.pdf`,'application/pdf',folder);i.receipt.combinedDriveFileId=f3.id;i.receipt.combinedDriveUrl=f3.webViewLink||'';}saveState();renderPage(currentPage);showToast('Recibo enviado ao Google Drive.');return true;}catch(e){console.error(e);showToast(e.message||'Falha no envio ao Drive.');return false;}}

  function openCalendar(){const n=state.installments.filter(i=>i.status!=='paid').sort((a,b)=>a.dueDate.localeCompare(b.dueDate))[0];if(!n){showToast('Nenhum vencimento pendente.');return;}const d=n.dueDate.replaceAll('-','');const end=new Date(n.dueDate+'T00:00:00');end.setDate(end.getDate()+1);const ed=end.toISOString().slice(0,10).replaceAll('-','');const url=`https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(n.label+' · ZMART Lar+')}&dates=${d}/${ed}&details=${encodeURIComponent('Valor: '+money(n.value)+'\nVenda: '+state.property.title)}`;window.open(url,'_blank','noopener');}

  // Ao abrir/recarregar a página: busca os dados mais recentes da nuvem (se configurada) ANTES de
  // mostrar a tela, para que vendedor e comprador sempre vejam o último estado sem precisar trocar
  // versão do app. Se a nuvem não estiver configurada ou a busca falhar, segue normalmente com a
  // cópia local — a tela nunca fica travada esperando a rede.
  async function syncFromCloudOnBoot(){
    if(!supabaseConfigured()) return;
    const cloudState=await pullStateFromSupabase();
    if(cloudState){
      state=normalizeState(cloudState);
      localStorage.setItem(DATA_KEY,JSON.stringify({version:STATE_VERSION,activeSaleId:state.activeSaleId,sales:state.sales,updatedAt:state.updatedAt}));
      activateSale(state.activeSaleId);
      // Push the deduplicated state back to Supabase to clean up any duplicate rows
      pushSalesToSupabase().catch(err=>console.warn('Limpeza pós-boot falhou:',err.message));
      if(role) render();
    }
  }
  render();
  let cloudBootPromise = syncFromCloudOnBoot();
})();
