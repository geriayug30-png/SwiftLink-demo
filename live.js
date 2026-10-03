'use strict';
window.SwiftLive = (() => {
  const config = window.SWIFTLINK_BACKEND || {};
  const db = config.publishableKey && window.supabase ? window.supabase.createClient(config.url, config.publishableKey, {
    auth: { storage: window.sessionStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  }) : null;
  const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const button = (text, fn, cls='button secondary') => { const n=node('button',cls,text); n.type='button'; n.addEventListener('click',fn); return n; };
  async function rpc(name, args={}) { if (!db) throw new Error('Backend connection is not configured yet.'); const {data,error}=await db.rpc(name,args); if(error) throw error; return data; }
  const labels = {general:'General',icu:'ICU',emergency:'Emergency',ambulance:'Ambulance'};
  const describe = r => (r.bed_type ? labels[r.bed_type]+' bed' : '') + (r.kind==='both'?' + ambulance':r.kind==='ambulance'?'Ambulance':'');
  const date = value => new Date(value).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
  function auth(onSession) {
    const form=document.querySelector('#auth-form'), message=document.querySelector('#auth-status');
    const gate=document.querySelector('#auth-gate'), app=document.querySelector('#authenticated');
    if (!db) { message.textContent='The secure backend is not connected yet. Please contact the site administrator.'; form.querySelectorAll('input,button').forEach(x=>x.disabled=true); return; }
    if(!config.emailDeliveryReady){form.querySelector('[value="register"]').disabled=true;message.textContent='New account registration is pending email-provider setup. Existing verified accounts can sign in. Contact the site owner for access.';}
    let generation=0;
    const update=async session=>{
      const current=++generation; gate.hidden=!!session; app.hidden=!session;
      document.querySelector('#sign-out').hidden=!session;
      if(!session) { app.querySelectorAll('[data-private]').forEach(n=>n.replaceChildren()); return; }
      try { await onSession(session,()=>current===generation); } catch(error) { message.textContent=error.message; gate.hidden=false; app.hidden=true; }
    };
    form.addEventListener('submit',async event=>{
      event.preventDefault(); const submit=event.submitter;
      if(submit.value==='register'&&!config.emailDeliveryReady)return;
      form.querySelectorAll('button').forEach(x=>x.disabled=true); message.textContent='Connecting securely…';
      const email=form.elements.email.value.trim(),password=form.elements.password.value;
      try {
        const result=submit.value==='register' ? await db.auth.signUp({email,password,options:{emailRedirectTo:location.origin+location.pathname}}) : await db.auth.signInWithPassword({email,password});
        if(result.error) throw result.error;
        form.elements.password.value='';
        message.textContent=submit.value==='register'?'Check your email to verify your account, then sign in. Staff access requires an administrator assignment.':'';
      } catch(error){message.textContent=error.message;}
      finally{form.querySelectorAll('button').forEach(x=>x.disabled=x.value==='register'&&!config.emailDeliveryReady);}
    });
    document.querySelector('#sign-out').addEventListener('click',async()=>{ const {error}=await db.auth.signOut({scope:'local'}); if(error) message.textContent=error.message; });
    db.auth.onAuthStateChange((event,session)=>{ if(event!=='TOKEN_REFRESHED') setTimeout(()=>update(session),0); });
  }
  return {db,node,button,rpc,labels,describe,date,auth};
})();
