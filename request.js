'use strict';
const {node,button,rpc,labels,describe,date,auth}=SwiftLive;
const $=s=>document.querySelector(s);
let directory=[],fetching=false,sending=false,epoch=0;
function status(text,error=false){$('#request-status').textContent=text;$('#request-status').style.color=error?'#a13236':'#0d6264';}
function showCapacity(){
  const h=directory.find(h=>h.id===$('#request-hospital').value);
  $('#public-capacity').replaceChildren();if(!h)return;
  h.capacity.forEach(c=>{const recent=c.verified_at&&Date.now()-Date.parse(c.verified_at)<1800000;$('#public-capacity').append(node('p','',labels[c.kind]+': '+(recent?c.available+' available · Confirmed '+date(c.verified_at):'Awaiting fresh confirmation')));});
}
function card(r){
  const c=node('article','request-card'),top=node('div','request-top');top.append(node('h3','','SL-'+r.id.slice(0,8).toUpperCase()),node('span','request-tag',r.status.replace('_',' ')));c.append(top,node('p','',r.hospital_name+' · '+describe(r)),node('p','','Sent '+date(r.created_at)));
  if(r.status==='pending')c.append(node('p','','Waiting for hospital confirmation. No bed or ambulance is reserved yet.'));
  if(r.status==='accepted')c.append(node('p','','Hospital accepted · Hold until '+date(r.hold_until)),node('p','','Expected arrival: '+r.eta_minutes+' minutes from acceptance. Contact the hospital if you need more time.'));
  if(r.status==='en_route')c.append(node('p','','Hospital marked the ambulance as dispatched. This is a staff update, not live tracking.'));
  if(['declined','expired','cancelled'].includes(r.status))c.append(node('p','','No capacity is held for this request. Contact a hospital to arrange care.'));
  if(['pending','accepted'].includes(r.status))c.append(button('Cancel request',async()=>{if(!confirm('Cancel this request and release any bed or vehicle reservation?'))return;try{await rpc('sl_cancel_request',{p_request:r.id});await refresh();status('Request cancelled.');}catch(e){status(e.message,true);}}));
  return c;
}
async function refresh(){
  if(fetching||$('#authenticated').hidden)return;fetching=true;const current=epoch;
  try{const [hospitals,requests]=await Promise.all([rpc('sl_directory'),rpc('sl_my_requests')]);if(current!==epoch||$('#authenticated').hidden)return;
    const chosen=$('#request-hospital').value;directory=hospitals;$('#request-hospital').replaceChildren(node('option','','Choose a hospital'));$('#request-hospital').firstChild.value='';
    hospitals.forEach(h=>{const o=node('option','',h.name+' · '+h.city);o.value=h.id;$('#request-hospital').append(o);});$('#request-hospital').value=chosen;showCapacity();
    $('#my-requests').replaceChildren(...(requests.length?requests.map(card):[node('div','staff-empty','No requests yet. Send a request to a participating hospital to get started.')]));
    $('#send-request').disabled=!hospitals.length||sending;status(hospitals.length?'Updated '+new Date().toLocaleTimeString():'No hospitals are accepting online requests yet. Use the hospital finder to contact a hospital directly.');
  }catch(e){status('Could not refresh: '+e.message,true);}
  finally{fetching=false;}
}
$('#request-hospital').addEventListener('change',showCapacity);
$('#request-kind').addEventListener('change',()=>{const kind=$('#request-kind').value;$('#request-bed-field').hidden=kind==='ambulance';$('#pickup-field').hidden=kind==='bed';$('#request-pickup').required=kind!=='bed';});
$('#care-request-form').addEventListener('submit',async event=>{
  event.preventDefault();if(sending)return;sending=true;$('#send-request').disabled=true;status('Sending request…');
  try{const kind=$('#request-kind').value;await rpc('sl_create_request',{p_hospital:$('#request-hospital').value,p_kind:kind,p_bed:kind==='ambulance'?null:$('#request-bed').value,p_pickup:kind==='bed'?'':$('#request-pickup').value.trim(),p_contact:$('#request-contact').value.trim()});
    $('#care-request-form').reset();$('#request-kind').dispatchEvent(new Event('change'));await refresh();status('Request sent. Wait for staff confirmation here; for urgent help call 112.');
  }catch(e){status(e.message,true);}finally{sending=false;$('#send-request').disabled=!directory.length;}
});
$('#refresh-requests').addEventListener('click',refresh);
auth(async()=>{++epoch;await refresh();});
setInterval(()=>{if(!document.hidden)refresh();},15000);
