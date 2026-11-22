import {json} from '@/lib/http';
export async function GET(){ return json({job:null}); }
export async function POST(){ return json({error:'Legacy Drive uploads are disabled. Use direct R2 upload.'},410); }
