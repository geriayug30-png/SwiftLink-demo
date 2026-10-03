window.SwiftDoctors = {
 render(rows, hospital) {
  const {node,date}=SwiftLive;
  const box=node('div','doctor-list');box.append(node('h3','','Doctor availability'));
  const doctors=rows.filter(d=>d.hospital_id===hospital);
  if(!doctors.length)box.append(node('p','','Specialties not yet reported by hospital staff.'));
  doctors.forEach(d=>{
   const fresh=Date.now()-Date.parse(d.verified_at)<1800000;
   box.append(node('p','',d.specialty+': '+(fresh?d.available+' available / '+d.total+' on roster':'Awaiting fresh confirmation')+' · Updated '+date(d.verified_at)));
  });
  box.append(node('p','section-help','Staff-reported availability; confirm before travelling. Doctor counts are not appointment reservations.'));
  return box;
 }
};
