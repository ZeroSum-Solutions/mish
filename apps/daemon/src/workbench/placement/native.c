/* Inactive daemon-owned movement primitive. One exclusive syscall, no restore or fallback. */
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/attr.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/utsname.h>
#include <uuid/uuid.h>
#include <libproc.h>

typedef struct { struct stat st; struct statfs fs; uuid_string_t uuid; int present; } parent;
typedef struct { struct stat st; int present; } object;
static parent sp, tp;
static object sb, tb, sa, ta;
static const char *invocation = "00000000-0000-0000-0000-000000000000";
static int decimal(const char *s, uint64_t *out) {
  if (!s || !*s || (s[0]=='0' && s[1])) return 0;
  uint64_t n=0;
  for (const unsigned char *p=(const unsigned char *)s; *p; p++) {
    if (*p<'0'||*p>'9'||n>(UINT64_MAX-(*p-'0'))/10) return 0;
    n=n*10+(*p-'0');
  }
  *out=n; return 1;
}
static int valid_uuid(const char *s) {
  if (!s || strlen(s)!=36) return 0;
  for (int i=0;i<36;i++) {
    if (i==8||i==13||i==18||i==23) { if(s[i]!='-') return 0; }
    else if (!((s[i]>='0'&&s[i]<='9')||(s[i]>='a'&&s[i]<='f'))) return 0;
  }
  return strcmp(s,"00000000-0000-0000-0000-000000000000")!=0;
}
static int name_ok(const char *s) {
  size_t len=s?strlen(s):0;
  if (!len||len>255||!strcmp(s,".")||!strcmp(s,"..")) return 0;
  const unsigned char *p=(const unsigned char *)s, *end=p+len;
  while(p<end) {
    unsigned char c=*p++; if(c<32||c==127||c=='/') return 0;
    if(c<128) continue;
    unsigned count; uint32_t code, floor;
    if(c>=0xc2&&c<=0xdf) {count=1;code=c&31;floor=0x80;}
    else if(c>=0xe0&&c<=0xef) {count=2;code=c&15;floor=0x800;}
    else if(c>=0xf0&&c<=0xf4) {count=3;code=c&7;floor=0x10000;}
    else return 0;
    if((size_t)(end-p)<count) return 0;
    while(count--) { if((*p&0xc0)!=0x80) return 0; code=(code<<6)|(*p++&63); }
    if(code<floor||code>0x10ffff||(code>=0xd800&&code<=0xdfff)) return 0;
  }
  return 1;
}
static const char *kind(mode_t mode) {
  return S_ISREG(mode)?"file":S_ISDIR(mode)?"directory":S_ISLNK(mode)?"symlink":"other";
}
static void emit_parent(const parent *p) {
  if(!p->present) { fputs("null",stdout); return; }
  printf("{\"device\":\"%llu\",\"inode\":\"%llu\",\"volumeUUID\":\"%s\"}",(unsigned long long)p->st.st_dev,(unsigned long long)p->st.st_ino,p->uuid);
}
static void emit_object(const object *o) {
  if(!o->present) { fputs("null",stdout); return; }
  printf("{\"device\":\"%llu\",\"inode\":\"%llu\",\"kind\":\"%s\",\"size\":\"%llu\",\"mode\":%u,\"links\":%u,\"flags\":%u}",(unsigned long long)o->st.st_dev,(unsigned long long)o->st.st_ino,kind(o->st.st_mode),(unsigned long long)o->st.st_size,(unsigned)o->st.st_mode,(unsigned)o->st.st_nlink,(unsigned)o->st.st_flags);
}
static int reply(const char *status,const char *reason,int error) {
  printf("{\"version\":1,\"invocationId\":\"%s\",\"status\":\"%s\",\"reason\":\"%s\",\"errno\":%d,\"sourceParent\":",invocation,status,reason,error);
  emit_parent(&sp); fputs(",\"targetParent\":",stdout); emit_parent(&tp);
  fputs(",\"sourceBefore\":",stdout); emit_object(&sb); fputs(",\"targetBefore\":",stdout); emit_object(&tb);
  fputs(",\"sourceAfter\":",stdout); emit_object(&sa); fputs(",\"targetAfter\":",stdout); emit_object(&ta);
  fputs("}\n",stdout); return fflush(stdout)==0 && !ferror(stdout)?0:74;
}
/* Refuse any unrelated inherited descriptor. No owner inode knowledge or flock copy. */
static int descriptors_ok(void) {
  struct proc_fdinfo fds[16];
  int bytes=proc_pidinfo(getpid(),PROC_PIDLISTFDS,0,fds,sizeof(fds));
  if(bytes<=0||bytes>=(int)sizeof(fds)||bytes%(int)sizeof(fds[0])) return 0;
  for(int i=0;i<bytes/(int)sizeof(fds[0]);i++) if(fds[i].proc_fd<0||fds[i].proc_fd>4) return 0;
  return 1;
}
static int runtime_ok(void) {
#if defined(__arm64__)
  struct utsname u; return uname(&u)==0&&!strcmp(u.release,"25.5.0")&&!strcmp(u.machine,"arm64");
#else
  return 0;
#endif
}
static int qualify(int fd,parent *p) {
  struct attrlist attrs={0}; attrs.bitmapcount=ATTR_BIT_MAP_COUNT;
  attrs.volattr=ATTR_VOL_INFO|ATTR_VOL_CAPABILITIES|ATTR_VOL_UUID;
  struct {uint32_t length;vol_capabilities_attr_t caps;uuid_t uuid;} data={0};
  if(fstat(fd,&p->st)<0||!S_ISDIR(p->st.st_mode)||fstatfs(fd,&p->fs)<0||fgetattrlist(fd,&attrs,&data,sizeof(data),0)<0) return 0;
  if(data.length!=sizeof(data)||!(p->fs.f_flags&MNT_LOCAL)||(p->fs.f_flags&MNT_RDONLY)||strcmp(p->fs.f_fstypename,"apfs")) return 0;
  if(!(data.caps.valid[VOL_CAPABILITIES_INTERFACES]&data.caps.capabilities[VOL_CAPABILITIES_INTERFACES]&VOL_CAP_INT_RENAME_EXCL)||!(data.caps.valid[VOL_CAPABILITIES_FORMAT]&VOL_CAP_FMT_CASE_SENSITIVE)||(data.caps.capabilities[VOL_CAPABILITIES_FORMAT]&VOL_CAP_FMT_CASE_SENSITIVE)) return 0;
  uuid_unparse_lower(data.uuid,p->uuid); if(!valid_uuid(p->uuid)) return 0;
  p->present=1; return 1;
}
static int observe(int fd,const char *name,object *o) {
  memset(o,0,sizeof(*o)); if(fstatat(fd,name,&o->st,AT_SYMLINK_NOFOLLOW)==0) {o->present=1;return 1;} return errno==ENOENT;
}
static int admitted(const object *o) {
  return o->present&&(S_ISREG(o->st.st_mode)||S_ISDIR(o->st.st_mode))&&!(o->st.st_flags&(SF_DATALESS|UF_IMMUTABLE|SF_IMMUTABLE|UF_APPEND|SF_APPEND))&&(!S_ISREG(o->st.st_mode)||o->st.st_nlink==1);
}
static int parent_matches(const parent *p,char **args) {
  uint64_t dev,ino; return decimal(args[0],&dev)&&decimal(args[1],&ino)&&valid_uuid(args[2])&&dev==(uint64_t)p->st.st_dev&&ino==(uint64_t)p->st.st_ino&&!strcmp(args[2],p->uuid);
}
int main(int argc,char **argv) {
  uint64_t pid,fd1,fd2,dev,ino;
  if(argc>3&&valid_uuid(argv[3])) invocation=argv[3];
  int parents=argc==7&&!strcmp(argv[1],"inspect-parents");
  int inspect=argc==9&&!strcmp(argv[1],"inspect");
  int move=argc==18&&!strcmp(argv[1],"move");
  if(!(parents||inspect||move)||strcmp(argv[2],"1")||!valid_uuid(invocation)||!decimal(argv[4],&pid)||pid==0||pid>INT32_MAX||!decimal(argv[5],&fd1)||fd1!=3||!decimal(argv[6],&fd2)||fd2!=4) return reply("conflict","protocol",EINVAL);
  if(!parents&&(!name_ok(argv[7])||!name_ok(argv[8]))) return reply("conflict","protocol",EINVAL);
  if(move&&(!decimal(argv[9],&dev)||!decimal(argv[10],&ino)||!valid_uuid(argv[11])||!decimal(argv[12],&dev)||!decimal(argv[13],&ino)||!valid_uuid(argv[14])||!decimal(argv[15],&dev)||!decimal(argv[16],&ino)||(strcmp(argv[17],"file")&&strcmp(argv[17],"directory")))) return reply("conflict","protocol",EINVAL);
  if(!descriptors_ok()) return reply("conflict","descriptor",0);
  if(!runtime_ok()) return reply("unsupported","runtime",0);
  if(!qualify(3,&sp)||!qualify(4,&tp)||sp.st.st_dev!=tp.st.st_dev||strcmp(sp.uuid,tp.uuid)||memcmp(&sp.fs.f_fsid,&tp.fs.f_fsid,sizeof(fsid_t))) return reply("unsupported","volume",0);
  if(parents) return reply("qualified","none",0);
  if(!observe(3,argv[7],&sb)||!observe(4,argv[8],&tb)) return reply("conflict","observation",errno);
  if(!admitted(&sb)||sb.st.st_dev!=sp.st.st_dev) return reply("conflict","source",0);
  if(tb.present) return reply("conflict",sb.st.st_dev==tb.st.st_dev&&sb.st.st_ino==tb.st.st_ino?"alias":"occupied",0);
  if(!move) return reply("qualified","none",0);
  if(!parent_matches(&sp,argv+9)||!parent_matches(&tp,argv+12)) return reply("conflict","parent",0);
  (void)decimal(argv[15],&dev); (void)decimal(argv[16],&ino);
  if(dev!=(uint64_t)sb.st.st_dev||ino!=(uint64_t)sb.st.st_ino||strcmp(argv[17],kind(sb.st.st_mode))) return reply("conflict","source",0);
  if((uint64_t)getppid()!=pid) return reply("conflict","orphan",0);
  /* Observations cannot implement expected-inode CAS against external same-user edits. */
  int rc=renameatx_np(3,argv[7],4,argv[8],RENAME_EXCL|RENAME_NOFOLLOW_ANY), error=rc?errno:0;
  if(!observe(3,argv[7],&sa)||!observe(4,argv[8],&ta)) return reply("unknown","observation",errno);
  if(rc) return reply(error==EEXIST?"conflict":"unknown","rename",error);
  return reply("moved","none",0);
}
