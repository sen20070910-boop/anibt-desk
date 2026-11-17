export const normalizedTitle=value=>String(value??'').normalize('NFKC').toLowerCase().trim();
export const subjectId=value=>/^\d{1,8}$/.test(String(value??''))&&Number(value)>0?String(Number(value)):'';
export const animeIdentity=item=>subjectId(item.bgmId)?'bgm:'+subjectId(item.bgmId):'title:'+normalizedTitle(item.animeTitle||item.title);
const episodePart=item=>item.episode&&!/^(batch|合集|全集)$/i.test(item.episode)?(/^\d+$/.test(item.episode)?String(Number(item.episode)):String(item.episode)):'';
export const episodeIdentity=item=>episodePart(item)&&(item.bgmId||item.animeTitle)?`${animeIdentity(item)}:${episodePart(item)}:${item.version||'v1'}`:'';
export const legacyEpisodeIdentity=item=>item.animeTitle&&episodePart(item)?`${normalizedTitle(item.animeTitle)}:${episodePart(item)}:${item.version||'v1'}`:'';
