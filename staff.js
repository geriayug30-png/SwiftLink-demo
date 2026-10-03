'use strict';
const {node,button,rpc,labels,describe,date,auth}=SwiftLive;
const $=s=>document.querySelector(s);
let hospitals=[], snapshot=null, selected='', busy=false, reading=false, revision=0, editing=null;
function status(text,error=false){$('#staff-status').textContent=text;$('#staff-status').classList.toggle('error',error);}
function empty(title,text){const n=node('div','staff-empty');n.append(node('strong','',title),node('p','',text));return n;}
function disable(value){$('#authenticated').querySelectorAll('button,select').forEach(n=>n.disabled=value);}
async function refresh(quiet=false){
  if(!selected||reading||busy||$('#authenticated').hidden) return;
  const id=selected,version=revision;reading=true;
  try{
    const data=await rpc('sl_staff_snapshot',{p_hospital:id});
    if(id!==selected||version!==revision||$('#authenticated').hidden)return;
    snapshot=data;render();status('Synced '+new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})+' · Shared across staff devices');
  }catch(e){status('Unable to sync: '+e.message+' Refresh before making changes.',true);disable(true);$('#refresh-staff').disabled=false;}
  finally{reading=false;}
}
async function mutate(name,args,success){
  if(busy)return;busy=true;++revision;disable(true);status('Saving…');
  let failure;
  try{await rpc(name,args);}catch(e){failure=e;}
  finally{busy=false;disable(false);}
  // Invalidate any stale in-flight snapshot; wait for it before a fresh read.
  while(reading)await new Promise(resolve=>setTimeout(resolve,50));
  await refresh();
  if(failure){status(failure.message,true);throw failure;}
  status(success);
}
function act(name,args,message){mutate(name,args,message).catch(()=>{});}
function edit(c){editing={...c,hospital:selected};$('#capacity-dialog-title').textContent='Set '+labels[c.kind].toLowerCase()+' capacity';$('#capacity-total').value=c.total;$('#capacity-free').value=c.free;$('#capacity-error').textContent='';$('#capacity-dialog').showModal();}
function capacity(c){
  const card=node('article','capacity-card'),top=node('div','capacity-top'),title=node('div');
  title.append(node('h3','',c.kind==='ambulance'?'Ready ambulances':labels[c.kind]+' beds'));
  const tags=node('div','cap-tags');tags.append(node('span','',c.kind==='icu'?'Intensive care':c.kind==='emergency'?'Emergency care':c.kind==='ambulance'?'Staff-managed fleet':'Inpatient care'));title.append(tags);
  const setup=button(c.total+' total · Edit',()=>edit(c),'text-button');top.append(title,setup);
  const stepper=node('div','capacity-stepper'),value=node('div','capacity-number');value.append(node('strong','',c.free),node('span','',c.kind==='ambulance'?'physical ready vehicles':'physical free beds'));
  const minus=button('−',()=>act('sl_adjust_capacity',{p_hospital:selected,p_kind:c.kind,p_delta:-1},'Capacity updated.'),'step-button');minus.setAttribute('aria-label','Decrease '+labels[c.kind]);minus.disabled=c.free<=c.held;
  const plus=button('+',()=>act('sl_adjust_capacity',{p_hospital:selected,p_kind:c.kind,p_delta:1},'Capacity updated.'),'step-button');plus.setAttribute('aria-label','Increase '+labels[c.kind]);plus.disabled=c.free>=c.total;
  stepper.append(minus,value,plus);
  const bottom=node('div','capacity-bottom'),available=node('span');available.append(node('strong','',c.free-c.held),' available to allocate');bottom.append(available,node('span','',c.held+' held · '+(c.total?Math.round((c.total-c.free)/c.total*100):0)+'% in use'));
  const stale=!c.verified_at||Date.parse(snapshot.server_time)-Date.parse(c.verified_at)>1800000;
  card.append(top,stepper,bottom,node('p','verified-note'+(stale?' stale':''),c.verified_at?'Confirmed '+date(c.verified_at)+(stale?' · Confirm again before accepting':''):'Counts not confirmed · Enter capacity to get started'));
  return card;
}
function request(r){
  const card=node('article','request-card'),top=node('div','request-top');top.append(node('h3','','SL-'+r.id.slice(0,8).toUpperCase()),node('span','request-tag'+(r.status!=='pending'?' accepted':''),r.status==='pending'?'Awaiting response':r.status==='en_route'?'Dispatched':'Capacity held'));
  card.append(top,node('p','',describe(r)),node('p','','Received '+date(r.created_at)));
  const phone=node('a','request-link','Call requester');phone.href='tel:'+r.contact;card.append(phone);
  if(r.pickup)card.append(node('p','','Pickup: '+r.pickup));
  const actions=node('div','request-actions');
  if(r.status==='pending'){
    const eta=node('input');eta.type='number';eta.min='1';eta.max='180';eta.value='15';eta.id='eta-'+r.id;
    const etaLabel=node('label','eta-input','Expected arrival (minutes)');etaLabel.htmlFor=eta.id;etaLabel.append(eta);card.append(etaLabel);
    const required=snapshot.capacity.filter(c=>c.kind===r.bed_type||(c.kind==='ambulance'&&r.kind!=='bed'));
    const needed=r.kind==='both'?2:1;
    const available=required.length===needed&&required.every(c=>c.free>c.held&&c.verified_at&&Date.parse(snapshot.server_time)-Date.parse(c.verified_at)<=1800000);
    const accept=button('Accept request',()=>{if(!eta.reportValidity())return;act('sl_respond',{p_request:r.id,p_action:'accept',p_eta:Number(eta.value)},'Request accepted. Capacity reserved for 20 minutes.');},'button primary');accept.disabled=!available;
    actions.append(accept,button('Decline',()=>act('sl_respond',{p_request:r.id,p_action:'decline'},'Request declined.')));
    if(!available)card.append(node('p','blocked','Confirm sufficient bed / ambulance capacity to accept.'));
  }else{
    const arrival=Date.parse(r.hold_until)-1200000+r.eta_minutes*60000;
    const meta=node('div','request-meta');meta.append(node('span','',r.status==='en_route'?'Held until arrival':'Hold until '+new Date(r.hold_until).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})),node('span','','Expected '+new Date(arrival).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})));card.append(meta);
    if(arrival<Date.parse(snapshot.server_time))card.append(node('p','danger-text','Arrival estimate has passed · Check with the requester.'));
    if(r.kind!=='bed'&&r.status==='accepted')actions.append(button('Confirm dispatched',()=>act('sl_respond',{p_request:r.id,p_action:'dispatch'},'Dispatch recorded. Capacity stays reserved.'),'button primary'));
    else actions.append(button('Mark arrived',()=>act('sl_respond',{p_request:r.id,p_action:'arrive'},'Arrival recorded. Bed occupied; dispatched vehicle removed from ready count.'),'button primary'));
    actions.append(button('Cancel hold',()=>{if(window.confirm('Cancel this accepted request and release its bed hold? An already dispatched vehicle will remain unavailable.'))act('sl_respond',{p_request:r.id,p_action:'cancel'},'Request cancelled.');}));
  }
  card.append(actions);return card;
}
function render(){
  disable(false);
  const beds=snapshot.capacity.filter(c=>c.kind!=='ambulance'),fleet=snapshot.capacity.find(c=>c.kind==='ambulance');
  $('#bed-cards').replaceChildren(...beds.sort((a,b)=>['general','icu','emergency'].indexOf(a.kind)-['general','icu','emergency'].indexOf(b.kind)).map(capacity));
  $('#fleet-controls').replaceChildren(...(fleet?[capacity(fleet)]:[empty('No fleet configured','Ask your administrator to configure ambulance capacity.')]));
  const incoming=snapshot.requests.filter(r=>r.status==='pending'),arrivals=snapshot.requests.filter(r=>r.status!=='pending');
  $('#available-count').textContent=beds.reduce((sum,c)=>sum+c.free-c.held,0);$('#held-count').textContent=beds.reduce((sum,c)=>sum+c.held,0);$('#pending-count').textContent=incoming.length;
  $('#incoming-badge').textContent=incoming.length;$('#arrivals-badge').textContent=arrivals.length;
  $('#incoming-list').replaceChildren(...(incoming.length?incoming.map(request):[empty('You’re up to date','New bed and ambulance requests will appear here.')]));
  $('#arrivals-list').replaceChildren(...(arrivals.length?arrivals.map(request):[empty('No expected arrivals','Accepted requests will appear here.')]));
  $('#activity-list').replaceChildren(...snapshot.activity.map(a=>{const li=node('li');li.append(node('time','',date(a.created_at)),node('span','',a.message));return li;}));
}
$('#staff-hospital').addEventListener('change',()=>{selected=$('#staff-hospital').value;++revision;snapshot=null;$('#hospital-city').textContent=hospitals.find(h=>h.id===selected)?.city||'';$('#bed-cards').replaceChildren();$('#incoming-list').replaceChildren();$('#arrivals-list').replaceChildren();refresh();});
$('#verify-beds').addEventListener('click',()=>{if(confirm('Confirm that all displayed physical bed and ready ambulance counts are current?'))act('sl_confirm_capacity',{p_hospital:selected},'Capacity confirmed.');});
$('#refresh-staff').addEventListener('click',()=>refresh());
$('#capacity-form').addEventListener('submit',async event=>{
  event.preventDefault();const submit=event.submitter;submit.disabled=true;
  try{await mutate('sl_set_capacity',{p_hospital:editing.hospital,p_kind:editing.kind,p_total:Number($('#capacity-total').value),p_free:Number($('#capacity-free').value),p_expected:editing.verified_at},'Confirmed capacity saved.');$('#capacity-dialog').close();}
  catch(e){$('#capacity-error').textContent=e.message;}
  finally{submit.disabled=false;}
});
auth(async(session,isCurrent)=>{
  const data=await rpc('sl_my_hospitals');if(!isCurrent())return;hospitals=data;
  if(!hospitals.length)throw new Error('This verified account has no hospital assignment. Ask the site owner to add your email to the staff access list.');
  $('#staff-hospital').replaceChildren(...hospitals.map(h=>{const o=node('option','',h.name);o.value=h.id;return o;}));
  selected=hospitals[0].id;++revision;$('#hospital-city').textContent=hospitals[0].city;await refresh();
});
setInterval(()=>{if(!document.hidden&&!$('#capacity-dialog').open&&!document.activeElement?.closest('.request-card'))refresh(true);},15000);
