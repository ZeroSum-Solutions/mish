/* Inactive in-process owner boundary: no raw fd API, spawn, dup, unlink or rotation. */
#include <node_api.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/attr.h>
#include <sys/acl.h>
#include <sys/mount.h>
#include <sys/utsname.h>
#include <fcntl.h>
#include <unistd.h>
#include <uuid/uuid.h>
#include <errno.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define OWNER_NAME ".daemon-placement-owner.lock"
typedef struct owner_context {
  int root_fd,owner_fd,close_errno;bool locked,tainted,closed;
  char *path; struct stat root, owner; uuid_string_t volume;
  struct owner_context *next;
} owner_context;
typedef struct { owner_context *head; } addon_state;
static void boolean(napi_env e,napi_value o,const char *key,bool value) { napi_value n; napi_get_boolean(e,value,&n); napi_set_named_property(e,o,key,n); }
static void string(napi_env e,napi_value o,const char *key,const char *value) { napi_value n; napi_create_string_utf8(e,value,NAPI_AUTO_LENGTH,&n); napi_set_named_property(e,o,key,n); }
static void number(napi_env e,napi_value o,const char *key,int value) { napi_value n; napi_create_int32(e,value,&n); napi_set_named_property(e,o,key,n); }
static void identity(napi_env e,napi_value o,const char *key,const struct stat *st) {
  napi_value value=NULL;if(!st) napi_get_null(e,&value);
  else { char buffer[32]; if(napi_create_object(e,&value)!=napi_ok) return;snprintf(buffer,sizeof(buffer),"%llu",(unsigned long long)st->st_dev); string(e,value,"device",buffer); snprintf(buffer,sizeof(buffer),"%llu",(unsigned long long)st->st_ino); string(e,value,"inode",buffer); }
  napi_set_named_property(e,o,key,value);
}
static napi_value result(napi_env e,const char *status,const char *reason,int error,napi_value owner) {
  napi_value value=NULL;if(napi_create_object(e,&value)!=napi_ok) return NULL;number(e,value,"version",1); string(e,value,"status",status); string(e,value,"reason",reason); number(e,value,"errno",error);
  if(owner) napi_set_named_property(e,value,"owner",owner); return value;
}
static int runtime_ok(napi_env e) {
#if defined(__arm64__)
  const napi_node_version *node=NULL;
  if(napi_get_node_version(e,&node)!=napi_ok||node->major!=24||node->minor!=16||node->patch!=0) return 0;
  struct utsname u; return uname(&u)==0&&!strcmp(u.release,"25.5.0")&&!strcmp(u.machine,"arm64");
#else
  (void)e;return 0;
#endif
}
static int volume_ok(int fd,uuid_string_t uuid) {
  errno=0;
  struct statfs fs; struct attrlist attrs={0}; attrs.bitmapcount=ATTR_BIT_MAP_COUNT; attrs.volattr=ATTR_VOL_INFO|ATTR_VOL_CAPABILITIES|ATTR_VOL_UUID;
  struct {uint32_t length;vol_capabilities_attr_t caps;uuid_t uuid;} data={0};
  if(fstatfs(fd,&fs)||fgetattrlist(fd,&attrs,&data,sizeof(data),0)) return 0;
  if(!(fs.f_flags&MNT_LOCAL)||(fs.f_flags&MNT_RDONLY)||strcmp(fs.f_fstypename,"apfs")||data.length!=sizeof(data)) {errno=ENOTSUP;return 0;}
  if(!(data.caps.valid[VOL_CAPABILITIES_INTERFACES]&data.caps.capabilities[VOL_CAPABILITIES_INTERFACES]&VOL_CAP_INT_FLOCK)) {errno=ENOTSUP;return 0;}
  uuid_unparse_lower(data.uuid,uuid);if(!strcmp(uuid,"00000000-0000-0000-0000-000000000000")) {errno=ENOTSUP;return 0;}return 1;
}
/* Only deny-only ACLs can refine the private POSIX mode without widening access. */
static int no_allow_acl(int fd) {
  errno=0;acl_t acl=acl_get_fd_np(fd,ACL_TYPE_EXTENDED);
  if(!acl) return errno==ENOENT;
  if(acl_valid(acl)) {int saved=errno;acl_free(acl);errno=saved;return 0;}
  acl_entry_t entry;acl_tag_t tag;int ok=1;
  for(int id=ACL_FIRST_ENTRY;acl_get_entry(acl,id,&entry)==0;id=ACL_NEXT_ENTRY) {
    if(acl_get_tag_type(entry,&tag)) {ok=0;break;}
    if(tag!=ACL_EXTENDED_DENY) {ok=0;errno=EACCES;break;}
  }
  int saved=errno;if(ok&&saved!=EINVAL) ok=0;acl_free(acl);errno=ok?0:saved;return ok;
}
static int safe_flags(const struct stat *st) { return !(st->st_flags&(SF_DATALESS|UF_IMMUTABLE|SF_IMMUTABLE|UF_APPEND|SF_APPEND)); }
static int root_safe(const struct stat *st) { return S_ISDIR(st->st_mode)&&st->st_uid==geteuid()&&(st->st_mode&07777)==0700&&safe_flags(st); }
static int owner_safe(const struct stat *st,const struct stat *root) { return S_ISREG(st->st_mode)&&st->st_uid==geteuid()&&(st->st_mode&07777)==0600&&st->st_nlink==1&&st->st_dev==root->st_dev&&safe_flags(st); }
static int same(const struct stat *a,const struct stat *b) { return a->st_dev==b->st_dev&&a->st_ino==b->st_ino&&(a->st_mode&S_IFMT)==(b->st_mode&S_IFMT); }
/* An uncertain close never proves release and never closes a reused foreign inode. */
static bool close_identified(int *fd,const struct stat *expected,int *error) {
  if(*fd<0) return true;
  struct stat actual;
  if(fstat(*fd,&actual)<0) { if(errno==EBADF) {*fd=-1;return true;} *error=errno;return false; }
  if(!same(&actual,expected)) {*fd=-1;return true;}
  if(close(*fd)==0) {*fd=-1;return true;}
  int saved=errno;
  if(fcntl(*fd,F_GETFD)<0&&errno==EBADF) {*fd=-1;return true;}
  *error=saved;return false;
}
static void close_owner(owner_context *ctx) {
  if(ctx->closed) return;
  int owner_error=0,root_error=0;
  bool owner_released=close_identified(&ctx->owner_fd,&ctx->owner,&owner_error);
  bool root_released=close_identified(&ctx->root_fd,&ctx->root,&root_error);
  ctx->close_errno=owner_error?owner_error:root_error;
  if(owner_released) ctx->locked=false;
  ctx->closed=owner_released&&root_released;ctx->tainted=true;
}
static void cleanup(void *data) {
  addon_state *state=data; owner_context *ctx=state->head;
  while(ctx) { owner_context *next=ctx->next; close_owner(ctx); free(ctx->path); free(ctx); ctx=next; }
  free(state);
}
static owner_context *receiver(napi_env e,napi_callback_info cb) {
  size_t argc=1;napi_value arg,self;void *ptr=NULL,*expected=NULL;
  if(napi_get_cb_info(e,cb,&argc,&arg,&self,&expected)!=napi_ok||argc!=0||napi_unwrap(e,self,&ptr)!=napi_ok||ptr!=expected) return NULL;
  return ptr;
}
static void inspect_context(owner_context *ctx,bool *held,bool *qualified,const char **reason,int *error) {
  *held=false;*qualified=false;*reason="protocol";*error=0;
  if(!ctx) return;
  struct stat owner,root,named_root,named_owner; uuid_string_t volume;
  *reason=ctx->closed?"closed":"descriptor";
  if(ctx->closed||!ctx->locked) return;
  int owner_flags=fcntl(ctx->owner_fd,F_GETFD);
  if(owner_flags<0) {
    if(errno==EBADF) {ctx->locked=false;ctx->owner_fd=-1;}
    else *held=true; // Unknown descriptor failure must not certify release.
    *error=errno;
    ctx->tainted=true;return;
  }
  if(fstat(ctx->owner_fd,&owner)<0) {*error=errno;*held=true;ctx->tainted=true;return;}
  if(!same(&owner,&ctx->owner)) {ctx->locked=false;ctx->owner_fd=-1;ctx->tainted=true;return;}
  *held=true;
  if(ctx->tainted) {*reason=ctx->close_errno?"close-uncertain":"tainted";*error=ctx->close_errno;return;}
  int root_flags=fcntl(ctx->root_fd,F_GETFD);
  if(root_flags<0||fstat(ctx->root_fd,&root)<0) {*error=errno;ctx->tainted=true;return;}
  if(!same(&root,&ctx->root)||!(owner_flags&FD_CLOEXEC)||!(root_flags&FD_CLOEXEC)) {ctx->tainted=true;return;}
  int named=open(ctx->path,O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW_ANY);
  *reason="root";
  if(named>=0) {
    char canonical[PATH_MAX];
    if(fstat(named,&named_root)<0) {*error=errno;*reason="root-unavailable";goto observed;}
    if(!same(&named_root,&ctx->root)||!root_safe(&named_root)||!root_safe(&root)) goto observed;
    if(!no_allow_acl(named)) {*error=errno;goto observed;}
    if(fcntl(named,F_GETPATH,canonical)<0) {*error=errno;*reason="root-unavailable";goto observed;}
    if(strcmp(canonical,ctx->path)) goto observed;
    *reason="owner";
    if(fstatat(named,OWNER_NAME,&named_owner,AT_SYMLINK_NOFOLLOW)<0) {*error=errno;*reason="owner-unavailable";goto observed;}
    if(!same(&named_owner,&ctx->owner)||!owner_safe(&named_owner,&named_root)||!owner_safe(&owner,&root)) goto observed;
    if(!no_allow_acl(ctx->owner_fd)) {*error=errno;goto observed;}
    *reason="volume";
    if(!volume_ok(named,volume)) {*error=errno;if(errno!=ENOTSUP)*reason="volume-unavailable";goto observed;}
    if(strcmp(volume,ctx->volume)) goto observed;
    *qualified=true;*reason="none";
observed:
    close(named);
  } else {*error=errno;if(errno!=ENOENT&&errno!=ELOOP&&errno!=ENOTDIR)*reason="root-unavailable";}
  if(!*qualified) ctx->tainted=true;
}
static napi_value inspect(napi_env e,napi_callback_info cb) {
  owner_context *ctx=receiver(e,cb);bool held,qualified;const char *reason;int error;
  inspect_context(ctx,&held,&qualified,&reason,&error);
  napi_value value=NULL;if(napi_create_object(e,&value)!=napi_ok) return NULL;boolean(e,value,"held",held);boolean(e,value,"qualified",qualified);string(e,value,"reason",reason);number(e,value,"errno",error);
  identity(e,value,"rootIdentity",ctx?&ctx->root:NULL);identity(e,value,"ownerIdentity",ctx?&ctx->owner:NULL);return value;
}
static napi_value release_owner(napi_env e,napi_callback_info cb) { owner_context *ctx=receiver(e,cb); if(ctx) close_owner(ctx); napi_value value; napi_get_undefined(e,&value); return value; }
static char *path_arg(napi_env e,napi_value value) {
  size_t len=0; if(napi_get_value_string_utf8(e,value,NULL,0,&len)!=napi_ok||!len||len>=PATH_MAX) return NULL;
  char *path=malloc(len+1); if(!path) return NULL;
  if(napi_get_value_string_utf8(e,value,path,len+1,&len)!=napi_ok||strlen(path)!=len||path[0]!='/') {free(path);return NULL;}
  for(size_t i=0;i<len;i++) if((unsigned char)path[i]<32||path[i]==127) {free(path);return NULL;}
  return path;
}
static napi_value failed_context(napi_env e,addon_state *state,owner_context *ctx,const char *status,const char *reason,int error) {
  close_owner(ctx);
  if(!ctx->closed) {ctx->next=state->head;state->head=ctx;return result(e,"conflict","close-uncertain",ctx->close_errno,NULL);}
  free(ctx->path);free(ctx);return result(e,status,reason,error,NULL);
}
static napi_value acquire(napi_env e,napi_callback_info cb) {
  size_t argc=2; napi_value args[2]; void *data=NULL;
  if(napi_get_cb_info(e,cb,&argc,args,NULL,&data)!=napi_ok||argc!=1) return result(e,"conflict","protocol",EINVAL,NULL);
  if(!runtime_ok(e)) return result(e,"unsupported","runtime",0,NULL);
  char *path=path_arg(e,args[0]); if(!path) return result(e,"conflict","canonical-root",EINVAL,NULL);
  int rootfd=open(path,O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW_ANY); struct stat root={0},owner={0}; char canonical[PATH_MAX]; uuid_string_t volume;
  if(rootfd<0) {int error=errno;free(path);return result(e,"conflict","root",error,NULL);}
  const char *reason="canonical-root"; int error=0,ownerfd=-1;
  if(fcntl(rootfd,F_GETPATH,canonical)) {error=errno;goto failure;}
  if(strcmp(canonical,path)) goto failure;
  reason="root";if(fstat(rootfd,&root)) {error=errno;goto failure;}
  if(!root_safe(&root)) goto failure;
  if(!no_allow_acl(rootfd)) {error=errno;goto failure;}
  reason="volume";if(!volume_ok(rootfd,volume)) {error=errno;close(rootfd);free(path);return result(e,error==ENOTSUP?"unsupported":"conflict",error==ENOTSUP?reason:"volume-unavailable",error,NULL);}
  /* O_NONBLOCK prevents opening a raced FIFO from blocking before type validation. */
  ownerfd=openat(rootfd,OWNER_NAME,O_RDWR|O_CREAT|O_EXCL|O_CLOEXEC|O_NOFOLLOW|O_NONBLOCK,0600);
  bool created=ownerfd>=0;
  if(ownerfd<0&&errno==EEXIST) ownerfd=openat(rootfd,OWNER_NAME,O_RDWR|O_CLOEXEC|O_NOFOLLOW|O_NONBLOCK);
  reason="owner";if(created&&fchmod(ownerfd,0600)) {error=errno;goto failure;}
  if(ownerfd<0||fstat(ownerfd,&owner)) {error=errno;goto failure;}
  if(!owner_safe(&owner,&root)) goto failure;
  if(!no_allow_acl(ownerfd)) {error=errno;goto failure;}
  addon_state *state=data;
  owner_context *ctx=calloc(1,sizeof(*ctx));
  if(!ctx) {error=ENOMEM;int ignored=0;close_identified(&ownerfd,&owner,&ignored);goto failure;}
  ctx->root_fd=rootfd;ctx->owner_fd=ownerfd;ctx->root=root;ctx->owner=owner;ctx->path=path;memcpy(ctx->volume,volume,sizeof(volume));
  if(flock(ownerfd,LOCK_EX|LOCK_NB)) {
    error=errno;return failed_context(e,state,ctx,error==EWOULDBLOCK?"busy":(error==ENOTSUP||error==ENOSYS)?"unsupported":"conflict",error==EWOULDBLOCK?"contended":"owner",error);
  }
  ctx->locked=true;
  bool held,qualified;const char *inspection_reason;int inspection_error;inspect_context(ctx,&held,&qualified,&inspection_reason,&inspection_error);
  if(!qualified) return failed_context(e,state,ctx,"conflict",inspection_reason,inspection_error);
  napi_value object;
  if(napi_create_object(e,&object)!=napi_ok||napi_wrap(e,object,ctx,NULL,NULL,NULL)!=napi_ok) {return failed_context(e,state,ctx,"conflict","native-protocol",0);}
  napi_property_descriptor methods[]={{"inspect",NULL,inspect,NULL,NULL,NULL,napi_default,ctx},{"close",NULL,release_owner,NULL,NULL,NULL,napi_default,ctx}};
  if(napi_define_properties(e,object,2,methods)!=napi_ok) {return failed_context(e,state,ctx,"conflict","native-protocol",0);}
  ctx->next=state->head;state->head=ctx;
  /* GC has no release finalizer. Explicit close or environment shutdown owns release. */
  return result(e,"owned","none",0,object);
failure:
  if(ownerfd>=0) close(ownerfd);close(rootfd);free(path);return result(e,"conflict",reason,error,NULL);
}
static napi_value capability(napi_env e,napi_callback_info cb) { (void)cb; return result(e,runtime_ok(e)?"supported":"unsupported",runtime_ok(e)?"none":"runtime",0,NULL); }
static napi_value init(napi_env e,napi_value exports) {
  addon_state *state=calloc(1,sizeof(*state)); if(!state) {napi_throw_error(e,NULL,"owner state allocation failed");return NULL;}
  if(napi_add_env_cleanup_hook(e,cleanup,state)!=napi_ok) {free(state);return NULL;}
  napi_property_descriptor methods[]={{"acquire",NULL,acquire,NULL,NULL,NULL,napi_default,state},{"capability",NULL,capability,NULL,NULL,NULL,napi_default,NULL}};
  if(napi_define_properties(e,exports,2,methods)!=napi_ok) return NULL; return exports;
}
NAPI_MODULE(placement_owner,init)
