import {json} from '@/lib/http';
export async function POST(){
  return json({ok:true,ignored:true,message:'Cloud storage cleanup is handled by R2 retention jobs.'});
}
